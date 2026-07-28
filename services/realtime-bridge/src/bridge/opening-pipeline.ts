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

export type OpeningPipelineEvent = {
  stage: OpeningPipelineStage;
  callSid?: string;
  timestampMs: number;
  detail?: string;
  stalledStage?: OpeningPipelineStage;
};

export function logOpeningPipelineEvent(event: OpeningPipelineEvent): void {
  const payload = {
    callSid: event.callSid,
    stage: event.stage,
    timestampMs: event.timestampMs,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.stalledStage ? { stalledStage: event.stalledStage } : {}),
  };

  if (event.stage === "timeout_fired" || event.stage === "recovery_attempted") {
    logWarn("opening_pipeline", payload);
    return;
  }

  logInfo("opening_pipeline", payload);
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
  | "first_audio_forwarded"
  | "completed";

export class GreetingWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private stage: GreetingWatchdogStage = "idle";
  private firstAudioForwarded = false;

  getStage(): GreetingWatchdogStage {
    return this.stage;
  }

  hasFirstAudioForwarded(): boolean {
    return this.firstAudioForwarded;
  }

  onGreetingRequested(callSid?: string): void {
    this.stage = "requested";
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

  schedule(onStalled: (stalledStage: GreetingWatchdogStage) => void, delayMs: number): void {
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
