import { logInfo } from "../logger.js";

export type TurnTimingMilestone =
  | "caller_speech_stopped"
  | "transcript_completed"
  | "next_response_requested"
  | "first_audio_delta_received"
  | "first_audio_sent_to_twilio";

export class TurnTimingTracker {
  private turnStartedAt: number | null = null;
  private readonly marks = new Map<TurnTimingMilestone, number>();

  beginTurn(callSid?: string): void {
    this.turnStartedAt = Date.now();
    this.marks.clear();
    logInfo("turn_timing_reset", { callSid });
  }

  record(milestone: TurnTimingMilestone, callSid?: string): void {
    if (this.turnStartedAt === null) {
      this.beginTurn(callSid);
    }

    if (this.marks.has(milestone)) {
      return;
    }

    const now = Date.now();
    this.marks.set(milestone, now);

    const payload: Record<string, number | string | undefined> = {
      callSid,
      milestone,
      elapsedMs: now - (this.turnStartedAt ?? now),
    };

    const speechStopped = this.marks.get("caller_speech_stopped");
    if (speechStopped !== undefined) {
      payload.sinceSpeechStoppedMs = now - speechStopped;
    }

    const transcriptCompleted = this.marks.get("transcript_completed");
    if (transcriptCompleted !== undefined) {
      payload.sinceTranscriptCompletedMs = now - transcriptCompleted;
    }

    const responseRequested = this.marks.get("next_response_requested");
    if (responseRequested !== undefined) {
      payload.sinceResponseRequestedMs = now - responseRequested;
    }

    logInfo("turn_timing", payload);

    if (milestone === "first_audio_sent_to_twilio") {
      this.logLargestDelay(callSid);
    }
  }

  private logLargestDelay(callSid?: string): void {
    const speechStopped = this.marks.get("caller_speech_stopped");
    const transcriptCompleted = this.marks.get("transcript_completed");
    const responseRequested = this.marks.get("next_response_requested");
    const firstDelta = this.marks.get("first_audio_delta_received");
    const firstSent = this.marks.get("first_audio_sent_to_twilio");

    if (
      speechStopped === undefined ||
      transcriptCompleted === undefined ||
      responseRequested === undefined ||
      firstDelta === undefined ||
      firstSent === undefined
    ) {
      return;
    }

    const segments = [
      { stage: "speech_stopped_to_transcript", ms: transcriptCompleted - speechStopped },
      { stage: "transcript_to_response_requested", ms: responseRequested - transcriptCompleted },
      { stage: "response_requested_to_first_delta", ms: firstDelta - responseRequested },
      { stage: "first_delta_to_twilio_send", ms: firstSent - firstDelta },
    ];

    const largest = segments.reduce((max, segment) =>
      segment.ms > max.ms ? segment : max,
    );

    logInfo("turn_timing_largest_delay", {
      callSid,
      stage: largest.stage,
      delayMs: largest.ms,
    });
  }
}
