import { logInfo } from "../logger.js";

export type CallTimingMilestone =
  | "twilio_stream_started"
  | "openai_connected"
  | "openai_session_ready"
  | "opening_response_requested"
  | "first_audio_sent_to_twilio";

export class CallTimingTracker {
  private readonly startedAt = Date.now();
  private readonly marks = new Map<CallTimingMilestone, number>();

  record(milestone: CallTimingMilestone, callSid?: string): void {
    if (this.marks.has(milestone)) {
      return;
    }

    const now = Date.now();
    this.marks.set(milestone, now);

    logInfo("call_timing", {
      callSid,
      milestone,
      elapsedMs: now - this.startedAt,
      sinceTwilioStartedMs: this.delta("twilio_stream_started", milestone),
      sinceOpenAiConnectedMs: this.delta("openai_connected", milestone),
      sinceSessionReadyMs: this.delta("openai_session_ready", milestone),
    });
  }

  private delta(from: CallTimingMilestone, to: CallTimingMilestone): number | undefined {
    const fromMs = this.marks.get(from);
    const toMs = this.marks.get(to);

    if (fromMs === undefined || toMs === undefined) {
      return undefined;
    }

    return toMs - fromMs;
  }
}
