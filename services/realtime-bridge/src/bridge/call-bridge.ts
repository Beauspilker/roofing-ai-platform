import type WebSocket from "ws";
import type { BridgeConfig } from "../config.js";
import { verifyStreamAuthToken } from "../auth/stream-token.js";
import { BargeInController } from "../bridge/barge-in.js";
import { PlaybackTracker } from "../bridge/playback-tracker.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { OpenAiRealtimeSession } from "../openai/realtime-session.js";
import { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import {
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioStreamEvent,
} from "../twilio/messages.js";

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
  private openAi: OpenAiRealtimeSession | null = null;
  private bargeIn: BargeInController | null = null;

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
        logInfo("twilio_mark_received", { mark: event.mark.name });
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
      await this.openAi.connect();
      const openingLine = await this.orchestrator.initialize();
      this.openAi.speakExactText(openingLine);
    } catch (error) {
      logError("stream_start_setup_failed", { callSid: start.callSid }, error);
      this.cleanup("stream_start_setup_failed");
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
      case "session.created":
      case "session.updated":
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
      case "response.audio.delta": {
        const delta = String(event.delta ?? "");
        this.forwardAssistantAudio(delta);
        break;
      }
      case "response.audio.done":
        logInfo("response_audio_done");
        break;
      case "response.done":
        this.bargeIn?.handleResponseCompleted();
        break;
      case "response.cancelled":
      case "response.canceled":
        this.bargeIn?.handleResponseCancelled();
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
    this.openAi.speakExactText(result.replyText);

    if (result.hangup) {
      setTimeout(() => this.cleanup("call_completed"), 1500);
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

    this.markCounter += 1;
    this.sendTwilioJson(
      buildTwilioMarkMessage(
        this.streamSid,
        `assistant-${this.markCounter}`,
      ) as unknown as Record<string, unknown>,
    );
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
