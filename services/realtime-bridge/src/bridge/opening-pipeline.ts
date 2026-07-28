import { logInfo, logWarn } from "../logger.js";

export type OpeningPipelineStage =
  | "twilio_connected"
  | "openai_connecting"
  | "openai_ready"
  | "session_configured"
  | "orchestrator_initialized"
  | "greeting_requested"
  | "response_created"
  | "first_audio_delta"
  | "first_audio_forwarded"
  | "greeting_audio_completed"
  | "story_question_requested"
  | "story_question_completed"
  | "caller_audio_detected"
  | "websocket_closed"
  | "twilio_stream_stopped"
  | "timeout_fired"
  | "recovery_attempted"
  | "call_ended";

export type GreetingRootCause =
  | "GREETING_NOT_REQUESTED"
  | "RESPONSE_CREATE_BLOCKED"
  | "RESPONSE_CREATE_TIMEOUT"
  | "FIRST_AUDIO_TIMEOUT"
  | "TWILIO_FORWARD_BLOCKED"
  | "GREETING_CANCELLED_DURING_STARTUP"
  | "RETRY_NOT_DISPATCHED"
  | "FALLBACK_UNAVAILABLE";

export type OpeningPipelineEvent = {
  stage: OpeningPipelineStage;
  callSid?: string;
  timestampMs: number;
  detail?: string;
  stalledStage?: OpeningPipelineStage | GreetingWatchdogStage;
  rootCause?: GreetingRootCause;
};

export function logOpeningPipelineEvent(event: OpeningPipelineEvent): void {
  const payload = {
    callSid: event.callSid,
    stage: event.stage,
    timestampMs: event.timestampMs,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.stalledStage ? { stalledStage: event.stalledStage } : {}),
    ...(event.rootCause ? { rootCause: event.rootCause } : {}),
  };

  if (event.stage === "timeout_fired" || event.stage === "recovery_attempted") {
    logWarn("opening_pipeline", payload);
    return;
  }

  logInfo("opening_pipeline", payload);
}

export class GreetingDeliveryTracker {
  greetingRequestSent = false;
  greetingResponseCreated = false;
  greetingFirstAudioReceived = false;
  greetingFirstAudioForwarded = false;
  greetingCompleted = false;
  greetingCancelledDuringStartup = false;
  fallbackRequested = false;
  fallbackProduced = false;
  fallbackForwarded = false;
  fallbackCompleted = false;
  fallbackUnavailable = false;
  lastRootCause: GreetingRootCause | null = null;

  markRequestSent(callSid?: string): void {
    this.greetingRequestSent = true;
    logOpeningPipelineEvent({
      stage: "greeting_requested",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_request_sent",
    });
  }

  markRequestBlocked(callSid?: string): void {
    this.lastRootCause = "RESPONSE_CREATE_BLOCKED";
    logOpeningPipelineEvent({
      stage: "greeting_requested",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_request_blocked",
      rootCause: "RESPONSE_CREATE_BLOCKED",
    });
  }

  markResponseCreated(callSid?: string): void {
    this.greetingResponseCreated = true;
  }

  markFirstAudioReceived(callSid?: string): void {
    this.greetingFirstAudioReceived = true;
  }

  markFirstAudioForwarded(callSid?: string): void {
    this.greetingFirstAudioForwarded = true;
  }

  markCompleted(callSid?: string): void {
    this.greetingCompleted = true;
  }

  markCancelledDuringStartup(callSid?: string): void {
    this.greetingCancelledDuringStartup = true;
    this.lastRootCause = "GREETING_CANCELLED_DURING_STARTUP";
    logOpeningPipelineEvent({
      stage: "recovery_attempted",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_cancelled_during_startup",
      rootCause: "GREETING_CANCELLED_DURING_STARTUP",
    });
  }

  markFallbackRequested(callSid?: string): void {
    this.fallbackRequested = true;
  }

  markFallbackProduced(callSid?: string): void {
    this.fallbackProduced = true;
  }

  markFallbackForwarded(callSid?: string): void {
    this.fallbackForwarded = true;
  }

  markFallbackCompleted(callSid?: string): void {
    this.fallbackCompleted = true;
  }

  markFallbackUnavailable(callSid?: string): void {
    this.fallbackUnavailable = true;
    this.lastRootCause = "FALLBACK_UNAVAILABLE";
    logOpeningPipelineEvent({
      stage: "recovery_attempted",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_fallback_unavailable",
      rootCause: "FALLBACK_UNAVAILABLE",
    });
  }

  resolveRootCause(stage: GreetingWatchdogStage): GreetingRootCause {
    if (this.greetingCancelledDuringStartup) {
      return "GREETING_CANCELLED_DURING_STARTUP";
    }

    if (!this.greetingRequestSent) {
      return "GREETING_NOT_REQUESTED";
    }

    if (!this.greetingResponseCreated) {
      return "RESPONSE_CREATE_TIMEOUT";
    }

    if (!this.greetingFirstAudioReceived) {
      return "FIRST_AUDIO_TIMEOUT";
    }

    if (!this.greetingFirstAudioForwarded) {
      return "TWILIO_FORWARD_BLOCKED";
    }

    return "FIRST_AUDIO_TIMEOUT";
  }
}

export class GreetingReadinessGate {
  private twilioStreamReady = false;
  private openAiConnected = false;
  private openAiSessionReady = false;
  private orchestratorInitialized = false;
  private greetingRequested = false;
  private greetingRetryUsed = false;

  markTwilioStreamReady(callSid?: string): void {
    this.twilioStreamReady = true;
    logOpeningPipelineEvent({
      stage: "twilio_connected",
      callSid,
      timestampMs: Date.now(),
    });
  }

  markOpenAiConnecting(callSid?: string): void {
    logOpeningPipelineEvent({
      stage: "openai_connecting",
      callSid,
      timestampMs: Date.now(),
    });
  }

  markOpenAiReady(callSid?: string): void {
    this.openAiConnected = true;
    logOpeningPipelineEvent({
      stage: "openai_ready",
      callSid,
      timestampMs: Date.now(),
    });
  }

  markSessionConfigured(callSid?: string): void {
    this.openAiSessionReady = true;
    logOpeningPipelineEvent({
      stage: "session_configured",
      callSid,
      timestampMs: Date.now(),
    });
  }

  markOrchestratorInitialized(callSid?: string): void {
    this.orchestratorInitialized = true;
    logOpeningPipelineEvent({
      stage: "orchestrator_initialized",
      callSid,
      timestampMs: Date.now(),
    });
  }

  isReady(): boolean {
    return (
      this.twilioStreamReady &&
      this.openAiConnected &&
      this.openAiSessionReady &&
      this.orchestratorInitialized
    );
  }

  canRequestGreeting(): boolean {
    return this.isReady() && !this.greetingRequested;
  }

  markGreetingRequested(callSid?: string): boolean {
    if (this.greetingRequested || !this.isReady()) {
      return false;
    }

    this.greetingRequested = true;
    logOpeningPipelineEvent({
      stage: "greeting_requested",
      callSid,
      timestampMs: Date.now(),
    });
    return true;
  }

  hasGreetingBeenRequested(): boolean {
    return this.greetingRequested;
  }

  canRetryGreeting(): boolean {
    return this.greetingRequested && !this.greetingRetryUsed;
  }

  markGreetingRetryUsed(callSid?: string): void {
    this.greetingRetryUsed = true;
    logOpeningPipelineEvent({
      stage: "recovery_attempted",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_retry",
    });
  }

  resetGreetingRequestForRetry(callSid?: string): void {
    this.greetingRequested = false;
    logOpeningPipelineEvent({
      stage: "recovery_attempted",
      callSid,
      timestampMs: Date.now(),
      detail: "greeting_request_reset_for_retry",
    });
  }
}

export type GreetingWatchdogStage =
  | "idle"
  | "requested"
  | "created"
  | "first_audio_received"
  | "first_audio_forwarded"
  | "completed";

export class GreetingWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private stage: GreetingWatchdogStage = "idle";
  private firstAudioReceived = false;
  private firstAudioForwarded = false;

  getStage(): GreetingWatchdogStage {
    return this.stage;
  }

  hasFirstAudioReceived(): boolean {
    return this.firstAudioReceived;
  }

  hasFirstAudioForwarded(): boolean {
    return this.firstAudioForwarded;
  }

  onGreetingRequested(callSid?: string): void {
    this.stage = "requested";
    this.firstAudioReceived = false;
    this.firstAudioForwarded = false;
    logOpeningPipelineEvent({
      stage: "greeting_requested",
      callSid,
      timestampMs: Date.now(),
      detail: "watchdog_started",
    });
  }

  onResponseCreated(callSid?: string): void {
    this.stage = "created";
    logOpeningPipelineEvent({
      stage: "response_created",
      callSid,
      timestampMs: Date.now(),
    });
  }

  onFirstAudioDelta(callSid?: string): void {
    if (!this.firstAudioReceived) {
      this.firstAudioReceived = true;
      this.stage = "first_audio_received";
    }

    logOpeningPipelineEvent({
      stage: "first_audio_delta",
      callSid,
      timestampMs: Date.now(),
    });
  }

  onFirstAudioForwarded(callSid?: string): void {
    if (this.firstAudioForwarded) {
      return;
    }

    this.firstAudioForwarded = true;
    this.stage = "first_audio_forwarded";
    this.clear();
    logOpeningPipelineEvent({
      stage: "first_audio_forwarded",
      callSid,
      timestampMs: Date.now(),
    });
  }

  onGreetingCompleted(callSid?: string): void {
    this.stage = "completed";
    this.clear();
    logOpeningPipelineEvent({
      stage: "greeting_audio_completed",
      callSid,
      timestampMs: Date.now(),
    });
  }

  schedule(
    onStalled: (stalledStage: GreetingWatchdogStage) => void,
    delayMs: number,
  ): void {
    this.clear();
    this.timer = setTimeout(() => {
      if (this.firstAudioForwarded) {
        return;
      }

      logOpeningPipelineEvent({
        stage: "timeout_fired",
        timestampMs: Date.now(),
        stalledStage: this.stage,
        detail: "greeting_watchdog",
      });
      onStalled(this.stage);
    }, delayMs);
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function resolveGreetingRootCause(
  stage: GreetingWatchdogStage,
  tracker: GreetingDeliveryTracker,
): GreetingRootCause {
  return tracker.resolveRootCause(stage);
}
