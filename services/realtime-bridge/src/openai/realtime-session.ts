import WebSocket from "ws";
import type { BridgeConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../logger.js";
import type { ResponseTriggerReason } from "../bridge/response-state-guard.js";

const REALTIME_INSTRUCTIONS =
  "You are a warm, professional roofing receptionist on a live phone call for Beau's Roofing. " +
  "Speak naturally with contractions, brief pauses, and confident phone energy. " +
  "Deliver exactly one short script per turn. Never ask more than one question. " +
  "Never invent intake questions or confirm details that were not provided by the server.";

export type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
};

export type SpeakRequestResult = "sent" | "blocked";

export class OpenAiRealtimeSession {
  private socket: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private sessionReadyPromise: Promise<void> | null = null;
  private sessionReadyResolve: (() => void) | null = null;
  private activeResponseId: string | null = null;
  private activeItemId: string | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly onEvent: (event: RealtimeServerEvent) => void,
    private readonly onDisconnect: (reason: string) => void,
  ) {}

  private resetSessionReady(): void {
    this.sessionReadyPromise = new Promise<void>((resolve) => {
      this.sessionReadyResolve = resolve;
    });
  }

  waitForSessionReady(): Promise<void> {
    return this.sessionReadyPromise ?? Promise.resolve();
  }

  getConfiguredVoice(): string {
    return this.config.openAiRealtimeVoice;
  }

  async connect(): Promise<void> {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.resetSessionReady();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openAiRealtimeModel)}`;

      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openAiApiKey}`,
        },
      });

      this.socket = socket;

      socket.on("open", () => {
        this.connected = true;
        logInfo("openai_connected", { voice: this.config.openAiRealtimeVoice });
        this.configureSession();
        resolve();
      });

      socket.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      socket.on("error", (error) => {
        logError("openai_socket_error", {}, error);
        if (!this.connected) {
          reject(error);
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        this.connected = false;
        this.connectPromise = null;
        this.sessionReadyPromise = null;
        this.sessionReadyResolve = null;
        const reason = reasonBuffer.toString() || String(code);
        logWarn("openai_disconnected", { code, reason });
        this.onDisconnect(reason);
      });
    });

    return this.connectPromise;
  }

  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: REALTIME_INSTRUCTIONS,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "low",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: this.config.openAiRealtimeVoice,
          },
        },
      },
    });
  }

  private handleMessage(raw: string): void {
    let event: RealtimeServerEvent;

    try {
      event = JSON.parse(raw) as RealtimeServerEvent;
    } catch {
      logWarn("openai_malformed_event");
      return;
    }

    if (event.type === "session.updated") {
      this.sessionReadyResolve?.();
      this.sessionReadyResolve = null;
    }

    if (event.type === "response.created") {
      const response = event.response as { id?: string } | undefined;
      this.activeResponseId = response?.id ?? null;
    }

    if (event.type === "response.output_item.added") {
      const item = event.item as { id?: string } | undefined;
      if (item?.id) {
        this.activeItemId = item.id;
      }
    }

    if (
      event.type === "response.done" ||
      event.type === "response.cancelled" ||
      event.type === "response.canceled"
    ) {
      this.activeResponseId = null;
    }

    if (event.type === "error") {
      logError("openai_realtime_error", {
        errorType: String(event.error ?? "unknown"),
      });
    }

    this.onEvent(event);
  }

  send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logWarn("openai_send_skipped_socket_closed", { type: String(payload.type) });
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  appendCallerAudio(base64Audio: string): void {
    if (!base64Audio) {
      return;
    }

    this.send({
      type: "input_audio_buffer.append",
      audio: base64Audio,
    });
  }

  speakScript(
    exactText: string,
    reason: ResponseTriggerReason,
    canSend: (reason: ResponseTriggerReason) => boolean,
    onSent: (reason: ResponseTriggerReason) => void,
  ): SpeakRequestResult {
    const trimmed = exactText.trim();

    if (!trimmed) {
      return "blocked";
    }

    if (!canSend(reason)) {
      return "blocked";
    }

    onSent(reason);

    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions:
          "Deliver this as one natural live phone response for Beau's Roofing. " +
          "Use contractions and warm professional tone. Ask at most one question. " +
          "Keep the same facts as the script below:\n\n" +
          trimmed,
      },
    });

    return "sent";
  }

  cancelActiveResponse(): void {
    if (this.activeResponseId) {
      this.send({
        type: "response.cancel",
        response_id: this.activeResponseId,
      });
      return;
    }

    this.send({ type: "response.cancel" });
  }

  getActiveResponseId(): string | null {
    return this.activeResponseId;
  }

  getActiveItemId(): string | null {
    return this.activeItemId;
  }

  close(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "call ended");
    }

    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.sessionReadyPromise = null;
    this.sessionReadyResolve = null;
    this.activeResponseId = null;
    this.activeItemId = null;
  }
}
