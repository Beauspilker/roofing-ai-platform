import type WebSocket from "ws";
import type { BridgeConfig } from "../config.js";
import { verifyStreamAuthToken } from "../auth/stream-token.js";
import { BargeInController } from "../bridge/barge-in.js";
import { CallTimingTracker } from "../bridge/call-timing.js";
import { PlaybackTracker } from "../bridge/playback-tracker.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { OpenAiRealtimeSession } from "../openai/realtime-session.js";
import { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import {
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioStreamEvent,
} from "../twilio/messages.js";

const CLOSING_MARK_NAME = "closing-final";

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
  private openAi: OpenAiRealtimeSession | null = null;
  private bargeIn: BargeInController | null = null;
  private openingGreetingSent = false;
  private awaitingClosingMark = false;
  private activeResponseUsesClosingMark = false;

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
      const connectPromise = this.openAi.connect().then(() => {
        this.callTiming.record("openai_connected", this.callSid ?? undefined);
      });
      const initPromise = this.orchestrator.initialize();
      const sessionReadyPromise = connectPromise.then(() =>
        this.openAi!.waitForSessionReady(),
      );

      const [openingLine] = await Promise.all([initPromise, sessionReadyPromise]);

      this.maybeSendOpeningGreeting(openingLine);
    } catch (error) {
      logError("stream_start_setup_failed", { callSid: start.callSid }, error);
      this.cleanup("stream_start_setup_failed");
    }
  }

  private maybeSendOpeningGreeting(openingLine: string): void {
    if (this.openingGreetingSent || !this.openAi) {
      return;
    }

    this.openingGreetingSent = true;
    this.callTiming.record("opening_response_requested", this.callSid ?? undefined);
    this.playbackTracker.reset();
    this.activeResponseUsesClosingMark = false;
    this.openAi.speakExactText(openingLine);
  }

  private handleStreamMedia(payload: string): void {
    if (!payload || !this.openAi) {
      return;
    }

    this.openAi.appendCallerAudio(payload);
  }

  private handleOpenAiEvent(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "session.created":
        break;
      case "session.updated":
        this.callTiming.record("openai_session_ready", this.callSid ?? undefined);
        logInfo("openai_session_ready", { type: event.type });
        break;
      case "input_audio_buffer.speech_started":
        this.bargeIn?.handleCallerSpeechStarted();
        break;
      case "input_audio_buffer.speech_stopped":
        this.openAi?.commitCallerAudio();
        break;
      case "conversation.item.input_audio_transcription.completed":
        void this.handleTranscriptionCompleted(event);
        break;
      case "response.created": {
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
        this.forwardAssistantAudio(delta);
        break;
      }
      case "response.output_audio.done":
        logInfo("response_output_audio_done");
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
        break;
      case "response.cancelled":
      case "response.canceled":
        this.bargeIn?.handleResponseCancelled();
        this.awaitingClosingMark = false;
        break;
      case "error":
        logError("openai_event_error", {
          errorType: String(event.error ?? "unknown"),
        });
        break;
      default:
        break;
    }
  }

  private async handleTranscriptionCompleted(event: {
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

    logInfo("caller_transcription_completed", {
      callSid: this.callSid ?? undefined,
      transcriptLength: transcript.length,
    });

    const result = await this.orchestrator.handleCallerTranscript(transcript);

    if (!result?.replyText) {
      return;
    }

    this.playbackTracker.reset();
    this.activeResponseUsesClosingMark = result.hangupAfterMark;
    this.awaitingClosingMark = result.hangupAfterMark;
    this.openAi.speakExactText(result.replyText);

    if (result.hangup && !result.hangupAfterMark) {
      this.cleanup("call_completed");
    }
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
    logInfo("call_bridge_cleanup", { reason, callSid: this.callSid ?? undefined });

    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    this.openAi?.close();
    this.openAi = null;

    if (this.params.twilioSocket.readyState === this.params.twilioSocket.OPEN) {
      this.params.twilioSocket.close(1000, reason);
    }
  }
}
