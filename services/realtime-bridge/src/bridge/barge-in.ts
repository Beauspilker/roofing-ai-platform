import type WebSocket from "ws";
import { logInfo } from "../logger.js";
import { buildTwilioClearMessage } from "../twilio/messages.js";

export type BargeInControllerOptions = {
  enabled: boolean;
  sendOpenAiEvent: (payload: Record<string, unknown>) => void;
  sendTwilioMessage: (payload: Record<string, unknown>) => void;
  getStreamSid: () => string | null;
  getPlayedDurationMs: () => number;
  getActiveResponseId: () => string | null;
  getActiveItemId: () => string | null;
  onAssistantSpeakingChange: (speaking: boolean) => void;
};

export class BargeInController {
  private assistantSpeaking = false;
  private activeResponseId: string | null = null;
  private activeItemId: string | null = null;
  private bargeInCount = 0;

  constructor(private readonly options: BargeInControllerOptions) {}

  setAssistantSpeaking(speaking: boolean): void {
    this.assistantSpeaking = speaking;
    this.options.onAssistantSpeakingChange(speaking);
  }

  isAssistantSpeaking(): boolean {
    return this.assistantSpeaking;
  }

  setActiveResponse(responseId: string | null, itemId: string | null): void {
    this.activeResponseId = responseId;
    this.activeItemId = itemId;
  }

  handleCallerSpeechStarted(): void {
    if (!this.options.enabled || !this.assistantSpeaking) {
      return;
    }

    const responseId = this.activeResponseId ?? this.options.getActiveResponseId();
    const itemId = this.activeItemId ?? this.options.getActiveItemId();
    const streamSid = this.options.getStreamSid();

    logInfo("barge_in_triggered", {
      responseId: responseId ?? undefined,
      bargeInCount: this.bargeInCount + 1,
    });

    this.bargeInCount += 1;

    if (responseId) {
      this.options.sendOpenAiEvent({
        type: "response.cancel",
        response_id: responseId,
      });
    } else {
      this.options.sendOpenAiEvent({ type: "response.cancel" });
    }

    if (itemId) {
      this.options.sendOpenAiEvent({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: this.options.getPlayedDurationMs(),
      });
    }

    if (streamSid) {
      this.options.sendTwilioMessage(
        buildTwilioClearMessage(streamSid) as unknown as Record<string, unknown>,
      );
    }

    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }

  handleResponseCancelled(): void {
    logInfo("response_cancelled");
    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }

  handleResponseCompleted(): void {
    logInfo("response_completed");
    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }

  handleResponseStarted(responseId: string, itemId: string | null): void {
    logInfo("response_started", { responseId });
    this.activeResponseId = responseId;
    this.activeItemId = itemId;
    this.setAssistantSpeaking(true);
  }
}

export function isOpenWebSocket(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN;
}
