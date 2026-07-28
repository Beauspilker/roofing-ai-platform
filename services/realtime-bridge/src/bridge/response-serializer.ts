import type { ResponseTriggerReason } from "./response-state-guard.js";
import { logInfo, logWarn } from "../logger.js";

export type ResponseDisposition = "sent" | "blocked" | "deduplicated" | "queued";

const CONFIRMATION_REASONS = new Set<ResponseTriggerReason>([
  "phone_confirmation",
  "address_confirmation",
]);

const OPENING_REASONS = new Set<ResponseTriggerReason>([
  "opening_greeting",
  "opening_name_question",
  "opening_silence_reprompt",
]);

export class ResponseSerializer {
  private activeReason: ResponseTriggerReason | null = null;
  private queuedReason: ResponseTriggerReason | null = null;
  private queuedText: string | null = null;

  getActiveReason(): ResponseTriggerReason | null {
    return this.activeReason;
  }

  isConfirmationActive(): boolean {
    return this.activeReason !== null && CONFIRMATION_REASONS.has(this.activeReason);
  }

  isOpeningActive(): boolean {
    return this.activeReason !== null && OPENING_REASONS.has(this.activeReason);
  }

  beginResponse(reason: ResponseTriggerReason): void {
    this.activeReason = reason;
    logInfo("response_serializer_active", { reason });
  }

  endResponse(): void {
    this.activeReason = null;
  }

  shouldBlockCallerTurnWhileActive(): boolean {
    return this.activeReason !== null;
  }

  planResponse(
    reason: ResponseTriggerReason,
    text: string,
    canSend: boolean,
  ): { disposition: ResponseDisposition; text: string } {
    if (!canSend) {
      if (this.activeReason === reason) {
        return { disposition: "deduplicated", text };
      }

      if (this.activeReason !== null) {
        this.queueResponse(reason, text);
        return { disposition: "queued", text };
      }

      return { disposition: "blocked", text };
    }

    if (this.activeReason !== null) {
      if (this.activeReason === reason) {
        logWarn("response_serializer_deduplicated", { reason });
        return { disposition: "deduplicated", text };
      }

      this.queueResponse(reason, text);
      return { disposition: "queued", text };
    }

    return { disposition: "sent", text };
  }

  consumeQueuedResponse():
    | { reason: ResponseTriggerReason; text: string }
    | null {
    if (this.activeReason !== null || !this.queuedReason || !this.queuedText) {
      return null;
    }

    const next = {
      reason: this.queuedReason,
      text: this.queuedText,
    };

    this.queuedReason = null;
    this.queuedText = null;
    return next;
  }

  clearQueue(): void {
    this.queuedReason = null;
    this.queuedText = null;
  }

  private queueResponse(reason: ResponseTriggerReason, text: string): void {
    this.queuedReason = reason;
    this.queuedText = text;
    logInfo("response_serializer_queued", { reason, activeReason: this.activeReason ?? undefined });
  }
}
