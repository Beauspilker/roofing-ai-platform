import WebSocket from "ws";
import type { BridgeConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../logger.js";

const REALTIME_INSTRUCTIONS =
  "You are the voice interface for Beau's Roofing phone receptionist. " +
  "You must speak only the exact text provided in each response instruction. " +
  "Never invent intake questions, never reorder required fields, and never confirm data " +
  "that was not supplied by the server. Use natural phone prosody and contractions.";

export type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
};

export class OpenAiRealtimeSession {
  private socket: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private activeResponseId: string | null = null;
  private activeItemId: string | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly onEvent: (event: RealtimeServerEvent) => void,
    private readonly onDisconnect: (reason: string) => void,
  ) {}

  async connect(): Promise<void> {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openAiRealtimeModel)}`;

      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openAiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.socket = socket;

      socket.on("open", () => {
        this.connected = true;
        logInfo("openai_connected");
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
        modalities: ["text", "audio"],
        instructions: REALTIME_INSTRUCTIONS,
        voice: this.config.openAiRealtimeVoice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: false,
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

  commitCallerAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  speakExactText(exactText: string): void {
    const trimmed = exactText.trim();

    if (!trimmed) {
      return;
    }

    this.send({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions:
          "Speak the following text exactly word-for-word with natural phone prosody. " +
          "Do not add, remove, or change any words:\n\n" +
          trimmed,
      },
    });
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
    this.activeResponseId = null;
    this.activeItemId = null;
  }
}
