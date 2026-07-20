import { logInfo, logWarn } from "../logger.js";

export type ResponseTriggerReason =
  | "opening_greeting"
  | "caller_turn_reply"
  | "closing_message";

export type BlockedTriggerCause =
  | "active_response"
  | "assistant_audio_pending"
  | "waiting_for_caller"
  | "awaiting_closing_mark"
  | "caller_turn_not_ready"
  | "duplicate_trigger";

export class ResponseStateGuard {
  private activeResponse = false;
  private clientInitiatedResponse = false;
  private waitingForCaller = false;
  private callerTurnReady = false;
  private awaitingClosingMark = false;
  private assistantAudioPending = false;
  private lastTranscriptItemId: string | null = null;

  canTriggerResponse(reason: ResponseTriggerReason): boolean {
    if (this.activeResponse) {
      this.logBlocked(reason, "active_response");
      return false;
    }

    if (this.assistantAudioPending) {
      this.logBlocked(reason, "assistant_audio_pending");
      return false;
    }

    if (this.awaitingClosingMark) {
      this.logBlocked(reason, "awaiting_closing_mark");
      return false;
    }

    if (reason !== "opening_greeting" && this.waitingForCaller && !this.callerTurnReady) {
      this.logBlocked(reason, "waiting_for_caller");
      return false;
    }

    if (reason === "caller_turn_reply" && !this.callerTurnReady) {
      this.logBlocked(reason, "caller_turn_not_ready");
      return false;
    }

    return true;
  }

  recordTrigger(reason: ResponseTriggerReason): void {
    logInfo("response_trigger", { reason });
    this.activeResponse = true;
    this.clientInitiatedResponse = true;
    this.callerTurnReady = false;
    this.waitingForCaller = false;
    this.assistantAudioPending = true;
  }

  onExternalResponseCreated(): boolean {
    if (this.activeResponse && this.clientInitiatedResponse) {
      this.logBlocked("caller_turn_reply", "duplicate_trigger");
      return false;
    }

    if (this.activeResponse) {
      logWarn("response_trigger_blocked", {
        reason: "vad_auto_response",
        cause: "active_response",
      });
      return true;
    }

    logInfo("response_trigger", { reason: "vad_auto_response" });
    this.activeResponse = true;
    this.clientInitiatedResponse = false;
    this.assistantAudioPending = true;
    return true;
  }

  onResponseDone(): void {
    this.activeResponse = false;
    this.clientInitiatedResponse = false;
    this.waitingForCaller = true;
    this.callerTurnReady = false;
    this.assistantAudioPending = false;
  }

  onResponseCancelled(): void {
    this.activeResponse = false;
    this.clientInitiatedResponse = false;
    this.assistantAudioPending = false;
    this.waitingForCaller = true;
    this.callerTurnReady = false;
  }

  onCallerSpeechStarted(): void {
    this.callerTurnReady = false;
  }

  onCallerSpeechStopped(): void {
    this.callerTurnReady = false;
  }

  registerCallerTranscript(itemId: string | null | undefined): boolean {
    if (itemId && itemId === this.lastTranscriptItemId) {
      logWarn("response_trigger_blocked", {
        reason: "caller_turn_reply",
        cause: "duplicate_trigger",
      });
      return false;
    }

    if (itemId) {
      this.lastTranscriptItemId = itemId;
    }

    this.callerTurnReady = true;
    return true;
  }

  onAssistantAudioDelta(): void {
    this.assistantAudioPending = true;
  }

  onAssistantAudioDone(): void {
    this.assistantAudioPending = false;
  }

  beginClosingMarkWait(): void {
    this.awaitingClosingMark = true;
    this.waitingForCaller = false;
    this.callerTurnReady = false;
  }

  onClosingMarkReceived(): void {
    this.awaitingClosingMark = false;
    this.assistantAudioPending = false;
    this.waitingForCaller = false;
    this.callerTurnReady = false;
  }

  isWaitingForCaller(): boolean {
    return this.waitingForCaller;
  }

  isActiveResponse(): boolean {
    return this.activeResponse;
  }

  isClientInitiatedResponse(): boolean {
    return this.clientInitiatedResponse;
  }

  private logBlocked(reason: ResponseTriggerReason, cause: BlockedTriggerCause): void {
    logWarn("response_trigger_blocked", { reason, cause });
  }
}
