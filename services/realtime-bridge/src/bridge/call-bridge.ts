import type WebSocket from "ws";
import type { BridgeConfig } from "../config.js";
import { verifyStreamAuthToken } from "../auth/stream-token.js";
import { BargeInController } from "../bridge/barge-in.js";
import { CallTimingTracker } from "../bridge/call-timing.js";
import { TurnTimingTracker } from "../bridge/turn-timing.js";
import {
  getLastTurnDiagnosticSnapshot,
  logCallDisconnect,
  logFirstAssistantAudioReceived,
  logResponseCreateSent,
  beginTurnDiagnostic,
} from "../bridge/turn-diagnostic.js";
import { PlaybackTracker } from "../bridge/playback-tracker.js";
import {
  ResponseStateGuard,
  type ResponseTriggerReason,
} from "../bridge/response-state-guard.js";
import {
  isMeaningfulOpeningCallerTranscript,
  OpeningSilenceController,
  OPENING_SILENCE_GOODBYE,
  type OpeningSilencePrompt,
} from "../bridge/opening-listening.js";
import {
  blockClosingPhraseForConversationState,
} from "../orchestrator/acknowledgment-policy.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { OpenAiRealtimeSession } from "../openai/realtime-session.js";
import { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import {
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioStreamEvent,
} from "../twilio/messages.js";

const CLOSING_MARK_NAME = "closing-final";
const OPENING_GREETING_DEADLINE_MS = 4_000;
const RESPONSE_WATCHDOG_MS = 2_000;
const OPENING_FALLBACK_GREETING =
  "Thank you for calling Beau's Roofing. One moment while I get ready to help you.";

type PendingSpeechRequest = {
  text: string;
  reason: ResponseTriggerReason;
  hangupAfterMark?: boolean;
  hangup?: boolean;
};

type CallBridgeParams = {
  twilioSocket: WebSocket;
  config: BridgeConfig;
};

export class CallBridge {
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private callerPhone = "";
  private calledPhone = "";
  private closed = false;
  private markCounter = 0;
  private callTimeout: NodeJS.Timeout | null = null;
  private orchestrator: SessionOrchestrator | null = null;
  private readonly playbackTracker = new PlaybackTracker();
  private readonly callTiming = new CallTimingTracker();
  private readonly turnTiming = new TurnTimingTracker();
  private readonly responseGuard = new ResponseStateGuard();
  private openAi: OpenAiRealtimeSession | null = null;
  private bargeIn: BargeInController | null = null;
  private openingGreetingSent = false;
  private awaitingClosingMark = false;
  private activeResponseUsesClosingMark = false;
  private pendingClientResponse = false;
  private pendingSpeech: PendingSpeechRequest | null = null;
  private openingFallbackTimer: NodeJS.Timeout | null = null;
  private activeTurnId = 0;
  private responseWatchdogTimer: NodeJS.Timeout | null = null;
  private responseWatchdogTurnId: number | null = null;
  private responseWatchdogRetryUsed = false;
  private responseWatchdogRequest: PendingSpeechRequest | null = null;
  private readonly openingSilence = new OpeningSilenceController();
  private openingGreetingPlaybackComplete = false;
  private queuedOpeningTranscript: string | null = null;
  private responseCreateCount = 0;
  private openingResponseCreateCount = 0;
  private postOpeningResponseCreateCount = 0;

  constructor(private readonly params: CallBridgeParams) {}

  start(): void {
    logInfo("twilio_stream_connected");

    this.params.twilioSocket.on("message", (data) => {
      this.handleTwilioMessage(data.toString());
    });

    this.params.twilioSocket.on("close", () => {
      this.cleanup("twilio_socket_closed");
    });

    this.params.twilioSocket.on("error", (error) => {
      logError("twilio_socket_error", {}, error);
      this.cleanup("twilio_socket_error");
    });
  }

  private handleTwilioMessage(raw: string): void {
    const event = parseTwilioStreamEvent(raw);

    if (!event) {
      logWarn("twilio_malformed_event");
      return;
    }

    switch (event.event) {
      case "connected":
        logInfo("twilio_stream_protocol_connected", {
          protocol: event.protocol,
          version: event.version,
        });
        break;
      case "start":
        void this.handleStreamStart(event.start);
        break;
      case "media":
        this.handleStreamMedia(event.media.payload);
        break;
      case "mark":
        this.handleTwilioMark(event.mark.name);
        break;
      case "stop":
        logInfo("twilio_stream_stopped");
        this.cleanup("twilio_stream_stopped");
        break;
      default:
        logWarn("twilio_unknown_event");
    }
  }

  private async handleStreamStart(start: {
    streamSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  }): Promise<void> {
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    this.callerPhone = start.customParameters?.callerPhone ?? "";
    this.calledPhone = start.customParameters?.calledPhone ?? "";

    const token = start.customParameters?.token;
    const tokenCallSid = start.customParameters?.callSid ?? start.callSid;

    if (
      !verifyStreamAuthToken(
        tokenCallSid,
        token,
        this.params.config.signingSecret,
      )
    ) {
      logError("stream_auth_failed", { callSid: start.callSid });
      this.sendTwilioClose();
      return;
    }

    this.callTiming.record("twilio_stream_started", start.callSid);

    logInfo("twilio_stream_started", {
      callSid: start.callSid,
      streamSid: start.streamSid,
      voice: this.params.config.openAiRealtimeVoice,
    });

    this.orchestrator = new SessionOrchestrator({
      callSid: start.callSid,
      callerPhone: this.callerPhone,
      calledPhone: this.calledPhone,
    });

    this.openAi = new OpenAiRealtimeSession(
      this.params.config,
      (event) => this.handleOpenAiEvent(event),
      (reason) => this.cleanup(`openai_disconnect:${reason}`),
    );

    this.bargeIn = new BargeInController({
      enabled: this.params.config.bargeInEnabled,
      sendOpenAiEvent: (payload) => this.openAi?.send(payload),
      sendTwilioMessage: (payload) => this.sendTwilioJson(payload),
      getStreamSid: () => this.streamSid,
      getPlayedDurationMs: () => this.playbackTracker.getPlayedDurationMs(),
      getActiveResponseId: () => this.openAi?.getActiveResponseId() ?? null,
      getActiveItemId: () => this.openAi?.getActiveItemId() ?? null,
      onAssistantSpeakingChange: () => {},
    });

    this.callTimeout = setTimeout(() => {
      logWarn("call_duration_limit_reached", { callSid: start.callSid });
      this.cleanup("max_call_duration");
    }, this.params.config.maxCallDurationSeconds * 1000);

    try {
      this.scheduleOpeningFallback();
      const connectPromise = this.openAi.connect().then(() => {
        this.callTiming.record("openai_connected", this.callSid ?? undefined);
      });
      const initPromise = this.orchestrator.initialize();
      const sessionReadyPromise = connectPromise.then(() =>
        this.openAi!.waitForSessionReady(),
      );

      const [openingLine] = await Promise.all([initPromise, sessionReadyPromise]);

      this.clearOpeningFallbackTimer();
      this.sendOpeningGreeting(openingLine);
    } catch (error) {
      logError("stream_start_setup_failed", { callSid: start.callSid }, error);
      this.clearOpeningFallbackTimer();
      this.sendOpeningGreeting(OPENING_FALLBACK_GREETING);
    }
  }

  private scheduleOpeningFallback(): void {
    this.clearOpeningFallbackTimer();
    this.openingFallbackTimer = setTimeout(() => {
      if (!this.openingGreetingSent) {
        logWarn("opening_greeting_fallback", { callSid: this.callSid ?? undefined });
        this.sendOpeningGreeting(OPENING_FALLBACK_GREETING);
      }
    }, OPENING_GREETING_DEADLINE_MS);
  }

  private clearOpeningFallbackTimer(): void {
    if (this.openingFallbackTimer) {
      clearTimeout(this.openingFallbackTimer);
      this.openingFallbackTimer = null;
    }
  }

  private sendOpeningGreeting(openingLine: string): void {
    if (this.openingGreetingSent || !this.openAi || !this.orchestrator) {
      return;
    }

    this.openingGreetingSent = true;
    this.clearOpeningFallbackTimer();
    this.callTiming.record("opening_response_requested", this.callSid ?? undefined);
    this.playbackTracker.reset();
    this.activeResponseUsesClosingMark = false;

    const sent = this.requestAssistantSpeech(openingLine, "opening_greeting");

    if (sent) {
      this.orchestrator.markOpeningDelivered();
    }
  }

  private beginOpeningReasonListen(): void {
    this.openingGreetingPlaybackComplete = true;
    this.openingSilence.beginListeningForReason();
    this.orchestrator?.onOpeningGreetingComplete();
    this.scheduleOpeningSilenceReprompt();

    const queued = this.queuedOpeningTranscript;
    this.queuedOpeningTranscript = null;

    if (queued) {
      void this.processCallerTranscriptAfterOpeningListen(queued);
    }
  }

  private async processCallerTranscriptAfterOpeningListen(transcript: string): Promise<void> {
    if (!this.orchestrator?.isOpeningGreetingPlaybackComplete()) {
      return;
    }

    if (
      this.openingSilence.isListeningForReason() &&
      !isMeaningfulOpeningCallerTranscript(transcript)
    ) {
      this.scheduleOpeningSilenceReprompt();
      return;
    }

    const itemId = `queued-opening-${Date.now()}`;

    if (!this.responseGuard.registerCallerTranscript(itemId)) {
      return;
    }

    if (isMeaningfulOpeningCallerTranscript(transcript)) {
      this.openingSilence.onMeaningfulCallerTranscript();
      this.responseGuard.completeOpeningReasonListen();
    }

    this.processCallerTurnReply(transcript);
  }

  private scheduleOpeningSilenceReprompt(): void {
    this.openingSilence.scheduleSilenceCheck((prompt) => {
      this.handleOpeningSilencePrompt(prompt);
    });
  }

  private handleOpeningSilencePrompt(prompt: OpeningSilencePrompt): void {
    if (this.closed || !this.openingSilence.isListeningForReason()) {
      return;
    }

    if (prompt === OPENING_SILENCE_GOODBYE) {
      this.requestAssistantSpeech(prompt, "opening_silence_reprompt");
      this.cleanup("opening_silence_timeout");
      return;
    }

    const sent = this.requestAssistantSpeech(prompt, "opening_silence_reprompt");
    if (sent) {
      this.scheduleOpeningSilenceReprompt();
    }
  }

  private requestAssistantSpeech(
    text: string,
    reason: ResponseTriggerReason,
    options: { hangupAfterMark?: boolean; turnId?: number } = {},
  ): boolean {
    if (!this.openAi) {
      return false;
    }

    const turnId = options.turnId ?? this.activeTurnId;

    const sent = this.openAi.speakScript(
      text,
      reason,
      (triggerReason) => this.responseGuard.canTriggerResponse(triggerReason),
      (triggerReason) => {
        this.pendingClientResponse = true;
        this.responseGuard.recordTrigger(triggerReason, turnId);
        this.responseCreateCount += 1;

        if (reason === "opening_greeting") {
          this.openingResponseCreateCount += 1;
        } else if (this.orchestrator?.hasMeaningfulCallerTranscript()) {
          this.postOpeningResponseCreateCount += 1;
        }

        this.turnTiming.record("response_create_sent", this.callSid ?? undefined, { turnId });
        logResponseCreateSent();
      },
    );

    if (sent === "sent") {
      this.playbackTracker.reset();
      this.activeResponseUsesClosingMark = options.hangupAfterMark ?? false;
      this.awaitingClosingMark = options.hangupAfterMark ?? false;

      if (options.hangupAfterMark) {
        this.responseGuard.beginClosingMarkWait();
      }
    }

    return sent === "sent";
  }

  private enqueueOrSpeakSpeech(
    request: PendingSpeechRequest,
    options: { turnId?: number } = {},
  ): boolean {
    const conversationState =
      this.orchestrator?.getConversationState() ?? "collecting_intake";
    const sanitizedText = blockClosingPhraseForConversationState(
      conversationState,
      request.text,
    ).trim();

    const turnId = options.turnId ?? this.activeTurnId;

    if (!sanitizedText) {
      if (request.reason === "closing_message") {
        return false;
      }

      logWarn("closing_phrase_blocked_during_intake", {
        callSid: this.callSid ?? undefined,
        conversationState,
        reason: request.reason,
      });

      if (request.reason === "caller_turn_reply") {
        return this.requestAssistantSpeech(
          "Thanks for your patience. Could you tell me what the roofing team can help you with?",
          request.reason,
          { hangupAfterMark: request.hangupAfterMark, turnId },
        );
      }

      return false;
    }

    const sent = this.requestAssistantSpeech(
      sanitizedText,
      request.reason,
      {
        hangupAfterMark: request.hangupAfterMark,
        turnId,
      },
    );

    if (sent) {
      if (request.hangup && !request.hangupAfterMark) {
        this.cleanup("call_completed");
      } else if (
        request.reason === "caller_turn_reply" &&
        !this.openingSilence.isListeningForReason()
      ) {
        this.scheduleResponseWatchdog(turnId, { ...request, text: sanitizedText });
      }
      return true;
    }

    this.pendingSpeech = { ...request, text: sanitizedText };
    logWarn("caller_turn_reply_deferred", { callSid: this.callSid ?? undefined, turnId });
    return false;
  }

  private flushPendingSpeech(): void {
    if (!this.pendingSpeech || !this.openAi) {
      return;
    }

    if (!this.responseGuard.canTriggerResponse(this.pendingSpeech.reason)) {
      return;
    }

    const pending = this.pendingSpeech;
    this.pendingSpeech = null;
    const sent = this.enqueueOrSpeakSpeech(pending);

    if (!sent && pending) {
      this.pendingSpeech = pending;
    }
  }

  private handleStreamMedia(payload: string): void {
    if (!payload || !this.openAi) {
      return;
    }

    this.openAi.appendCallerAudio(payload);
  }

  private handleOpenAiEvent(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "session.updated":
        this.callTiming.record("openai_session_ready", this.callSid ?? undefined);
        logInfo("openai_session_ready", { type: event.type });
        break;
      case "input_audio_buffer.speech_started":
        this.responseGuard.onCallerSpeechStarted();
        this.bargeIn?.handleCallerSpeechStarted();
        break;
      case "input_audio_buffer.speech_stopped":
        this.activeTurnId += 1;
        this.responseGuard.beginCallerTurn(this.activeTurnId);
        this.turnTiming.beginTurn(this.callSid ?? undefined, this.activeTurnId);
        this.turnTiming.record("speech_stopped", this.callSid ?? undefined, {
          turnId: this.activeTurnId,
        });
        break;
      case "conversation.item.input_audio_transcription.completed":
        void this.handleTranscriptionCompleted(event);
        break;
      case "response.created": {
        if (this.pendingClientResponse) {
          this.pendingClientResponse = false;
        } else {
          logWarn("vad_auto_response_cancelled");
          this.openAi?.cancelActiveResponse();
          this.responseGuard.onResponseCancelled();
          break;
        }

        const responseId = (event.response as { id?: string } | undefined)?.id;
        if (responseId) {
          this.bargeIn?.handleResponseStarted(
            responseId,
            this.openAi?.getActiveItemId() ?? null,
          );
        }
        break;
      }
      case "response.output_audio.delta": {
        const delta = String(event.delta ?? "");

        if (this.responseGuard.isStaleResponseAudio(this.activeTurnId)) {
          logWarn("stale_audio_delta_ignored", {
            callSid: this.callSid ?? undefined,
            activeTurnId: this.activeTurnId,
            responseTurnId: this.responseGuard.getResponseTurnId(),
          });
          break;
        }

        this.clearResponseWatchdog();
        this.turnTiming.record("first_audio_received", this.callSid ?? undefined, {
          turnId: this.activeTurnId,
        });
        logFirstAssistantAudioReceived();
        this.responseGuard.onAssistantAudioDelta();
        this.forwardAssistantAudio(delta);
        break;
      }
      case "response.output_audio.done":
        logInfo("response_output_audio_done");
        this.responseGuard.onAssistantAudioDone();
        if (this.awaitingClosingMark && this.streamSid) {
          this.sendTwilioJson(
            buildTwilioMarkMessage(this.streamSid, CLOSING_MARK_NAME) as unknown as Record<
              string,
              unknown
            >,
          );
          this.awaitingClosingMark = false;
        }
        break;
      case "response.done":
        this.bargeIn?.handleResponseCompleted();
        this.responseGuard.onResponseDone();

        if (this.responseGuard.wasLastResponseOpeningGreeting()) {
          this.beginOpeningReasonListen();
          this.orchestrator?.onAssistantResponseDone();
          this.clearResponseWatchdog();
          this.pendingSpeech = null;
          break;
        }

        if (
          this.responseGuard.getLastTriggerReason() === "opening_silence_reprompt"
        ) {
          this.scheduleOpeningSilenceReprompt();
        }

        this.orchestrator?.onAssistantResponseDone();
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "response.failed":
        logWarn("openai_response_failed", { callSid: this.callSid ?? undefined });
        this.bargeIn?.handleResponseCancelled();
        this.responseGuard.onResponseFailed();
        this.pendingClientResponse = false;
        this.awaitingClosingMark = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "response.cancelled":
      case "response.canceled":
        this.bargeIn?.handleResponseCancelled();
        this.responseGuard.onResponseCancelled();
        this.pendingClientResponse = false;
        this.awaitingClosingMark = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "error":
        logError("openai_event_error", {
          errorType: String(event.error ?? "unknown"),
        });
        this.responseGuard.onOpenAiError();
        this.pendingClientResponse = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      default:
        break;
    }
  }

  private handleTranscriptionCompleted(event: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    const transcript = String(
      (event.transcript as string | undefined) ??
        ((event.item as { transcript?: string } | undefined)?.transcript ?? ""),
    ).trim();

    if (!transcript || !this.orchestrator || !this.openAi) {
      return;
    }

    if (this.openingGreetingSent && !this.openingGreetingPlaybackComplete) {
      this.queuedOpeningTranscript = transcript;
      logInfo("opening_transcript_queued_until_greeting_done", {
        callSid: this.callSid ?? undefined,
        transcriptLength: transcript.length,
      });
      return;
    }

    if (
      this.openingSilence.isListeningForReason() &&
      !isMeaningfulOpeningCallerTranscript(transcript)
    ) {
      logInfo("opening_transcript_ignored_at_bridge", {
        callSid: this.callSid ?? undefined,
        transcriptLength: transcript.length,
      });
      this.scheduleOpeningSilenceReprompt();
      return;
    }

    const itemId = String(
      (event.item_id as string | undefined) ??
        ((event.item as { id?: string } | undefined)?.id ?? ""),
    );

    if (!this.responseGuard.registerCallerTranscript(itemId || null)) {
      return;
    }

    logInfo("caller_transcription_completed", {
      callSid: this.callSid ?? undefined,
      transcriptLength: transcript.length,
    });

    this.turnTiming.record("transcript_completed", this.callSid ?? undefined, {
      turnId: this.activeTurnId,
    });

    beginTurnDiagnostic(this.callSid ?? "unknown", this.activeTurnId);

    if (isMeaningfulOpeningCallerTranscript(transcript)) {
      this.openingSilence.onMeaningfulCallerTranscript();
      this.responseGuard.completeOpeningReasonListen();
    }

    void this.processCallerTurnReply(transcript);
  }

  private scheduleResponseWatchdog(turnId: number, request: PendingSpeechRequest): void {
    if (this.openingSilence.isListeningForReason()) {
      return;
    }

    this.clearResponseWatchdog();
    this.responseWatchdogTurnId = turnId;
    this.responseWatchdogRequest = request;
    this.responseWatchdogRetryUsed = false;

    this.responseWatchdogTimer = setTimeout(() => {
      this.handleResponseWatchdogTimeout(turnId);
    }, RESPONSE_WATCHDOG_MS);
  }

  private clearResponseWatchdog(): void {
    if (this.responseWatchdogTimer) {
      clearTimeout(this.responseWatchdogTimer);
      this.responseWatchdogTimer = null;
    }

    this.responseWatchdogTurnId = null;
    this.responseWatchdogRequest = null;
    this.responseWatchdogRetryUsed = false;
  }

  private handleResponseWatchdogTimeout(turnId: number): void {
    if (this.closed || this.responseWatchdogTurnId !== turnId) {
      return;
    }

    if (this.turnTiming.hasFirstAudio()) {
      return;
    }

    if (this.responseWatchdogRetryUsed) {
      logWarn("response_watchdog_exhausted", {
        callSid: this.callSid ?? undefined,
        turnId,
      });
      this.responseGuard.releaseActiveResponse({
        waitingForCaller: true,
        preserveCallerTurnReady: true,
      });
      return;
    }

    const request = this.responseWatchdogRequest;

    if (!request) {
      return;
    }

    logWarn("response_watchdog_retry", {
      callSid: this.callSid ?? undefined,
      turnId,
    });

    this.responseWatchdogRetryUsed = true;
    this.responseGuard.prepareCallerTurnRecovery();
    this.pendingClientResponse = false;
    this.enqueueOrSpeakSpeech(request, { turnId });
  }

  private attemptEmptyReplyRecovery(transcript: string): void {
    logWarn("caller_turn_empty_reply_recovery", {
      callSid: this.callSid ?? undefined,
      transcriptLength: transcript.length,
      turnId: this.activeTurnId,
    });

    this.responseGuard.prepareCallerTurnRecovery();

    this.enqueueOrSpeakSpeech({
      text: "Thanks for your patience. Could you repeat that last answer for me?",
      reason: "caller_turn_reply",
    });
  }

  private processCallerTurnReply(transcript: string): void {
    if (!this.orchestrator || !this.openAi) {
      return;
    }

    const turnId = this.activeTurnId;

    void this.orchestrator.handleCallerTranscript(transcript, this.activeTurnId).then((result) => {
      if (this.turnTiming.isStaleTurn(turnId)) {
        return;
      }

      this.turnTiming.record("caller_turn_processed", this.callSid ?? undefined, { turnId });

      if (!result?.replyText) {
        if (this.openingSilence.isListeningForReason()) {
          return;
        }

        this.attemptEmptyReplyRecovery(transcript);
        return;
      }

      if (result.structuredStateUpdated) {
        this.turnTiming.record("structured_state_updated", this.callSid ?? undefined, { turnId });
      }

      this.turnTiming.record("next_question_selected", this.callSid ?? undefined, { turnId });
      this.turnTiming.record("response_requested", this.callSid ?? undefined, { turnId });

      const reason: ResponseTriggerReason = result.hangupAfterMark
        ? "closing_message"
        : "caller_turn_reply";

      this.enqueueOrSpeakSpeech(
        {
          text: result.replyText,
          reason,
          hangupAfterMark: result.hangupAfterMark,
          hangup: result.hangup,
        },
        { turnId },
      );
    }).catch((error) => {
      logError("caller_turn_processing_failed", { callSid: this.callSid ?? undefined, turnId }, error);
      this.responseGuard.prepareCallerTurnRecovery();
      this.enqueueOrSpeakSpeech(
        {
          text: "Thanks for your patience. Could you repeat that last answer for me?",
          reason: "caller_turn_reply",
        },
        { turnId },
      );
    });
  }

  private async processQueuedCallerTranscript(): Promise<void> {
    if (!this.orchestrator || !this.orchestrator.hasPendingTranscript()) {
      return;
    }

    if (this.openingSilence.isListeningForReason()) {
      return;
    }

    if (!this.responseGuard.isWaitingForCaller()) {
      return;
    }

    const pending = this.orchestrator.consumePendingTranscript();

    if (!pending) {
      return;
    }

    if (!this.responseGuard.registerCallerTranscript(`queued-${Date.now()}`)) {
      return;
    }

    logInfo("caller_transcript_dequeued", { callSid: this.callSid ?? undefined });
    this.processCallerTurnReply(pending);
  }

  private forwardAssistantAudio(base64Audio: string): void {
    if (!base64Audio || !this.streamSid) {
      return;
    }

    const payloadBuffer = Buffer.from(base64Audio, "base64");
    this.playbackTracker.recordOutboundBytes(payloadBuffer.length);

    this.sendTwilioJson(
      buildTwilioMediaMessage(this.streamSid, base64Audio) as unknown as Record<
        string,
        unknown
      >,
    );

    this.turnTiming.record("first_audio_sent_to_twilio", this.callSid ?? undefined, {
      turnId: this.activeTurnId,
    });
    this.callTiming.record("first_audio_sent_to_twilio", this.callSid ?? undefined);

    if (!this.activeResponseUsesClosingMark) {
      this.markCounter += 1;
      this.sendTwilioJson(
        buildTwilioMarkMessage(
          this.streamSid,
          `assistant-${this.markCounter}`,
        ) as unknown as Record<string, unknown>,
      );
    }
  }

  private handleTwilioMark(name: string): void {
    logInfo("twilio_mark_received", { mark: name });

    if (name === CLOSING_MARK_NAME) {
      logInfo("closing_mark_played", { callSid: this.callSid ?? undefined });
      this.orchestrator?.onClosingMarkPlayed();
      this.responseGuard.onClosingMarkReceived();
      this.cleanup("call_completed");
    }
  }

  private sendTwilioJson(payload: Record<string, unknown>): void {
    if (this.closed || this.params.twilioSocket.readyState !== this.params.twilioSocket.OPEN) {
      return;
    }

    try {
      this.params.twilioSocket.send(JSON.stringify(payload));
    } catch (error) {
      logError("twilio_send_failed", {}, error);
    }
  }

  private sendTwilioClose(): void {
    if (this.params.twilioSocket.readyState === this.params.twilioSocket.OPEN) {
      this.params.twilioSocket.close(1008, "unauthorized");
    }
  }

  private cleanup(reason: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    logCallDisconnect({
      callId: this.callSid ?? undefined,
      reason,
      conversationState: this.orchestrator?.getConversationState() ?? null,
      lastSnapshot: getLastTurnDiagnosticSnapshot(),
      callerHeardMessage: reason === "call_completed" || reason.includes("closing"),
      leadPreserved: true,
    });

    logInfo("call_bridge_cleanup", { reason, callSid: this.callSid ?? undefined });

    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    this.clearOpeningFallbackTimer();
    this.clearResponseWatchdog();
    this.openingSilence.reset();
    this.pendingSpeech = null;

    this.responseGuard.onWebSocketClosed();

    this.openAi?.close();
    this.openAi = null;

    if (this.params.twilioSocket.readyState === this.params.twilioSocket.OPEN) {
      this.params.twilioSocket.close(1000, reason);
    }
  }
}
