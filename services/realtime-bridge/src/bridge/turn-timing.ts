import { logInfo } from "../logger.js";

export type TurnTimingMilestone =
  | "speech_stopped"
  | "transcript_completed"
  | "structured_state_updated"
  | "response_requested"
  | "first_audio_received"
  | "first_audio_sent_to_twilio";

type StageSegment = {
  stage: string;
  ms: number;
};

export class TurnTimingTracker {
  private turnStartedAt: number | null = null;
  private readonly marks = new Map<TurnTimingMilestone, number>();
  private readonly stageTotals = new Map<string, { totalMs: number; count: number }>();

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

    logInfo("turn_timing", {
      callSid,
      milestone,
      elapsedMs: now - (this.turnStartedAt ?? now),
    });

    if (milestone === "first_audio_sent_to_twilio") {
      this.recordStageSegments(callSid);
    }
  }

  private recordStageSegments(callSid?: string): void {
    const speechStopped = this.marks.get("speech_stopped");
    const transcriptCompleted = this.marks.get("transcript_completed");
    const structuredUpdated = this.marks.get("structured_state_updated");
    const responseRequested = this.marks.get("response_requested");
    const firstReceived = this.marks.get("first_audio_received");
    const firstSent = this.marks.get("first_audio_sent_to_twilio");

    if (
      speechStopped === undefined ||
      transcriptCompleted === undefined ||
      structuredUpdated === undefined ||
      responseRequested === undefined ||
      firstReceived === undefined ||
      firstSent === undefined
    ) {
      return;
    }

    const segments: StageSegment[] = [
      { stage: "speech_stopped_to_transcript", ms: transcriptCompleted - speechStopped },
      { stage: "transcript_to_structured_state", ms: structuredUpdated - transcriptCompleted },
      { stage: "structured_state_to_response_requested", ms: responseRequested - structuredUpdated },
      { stage: "response_requested_to_first_audio", ms: firstReceived - responseRequested },
      { stage: "first_audio_to_twilio_send", ms: firstSent - firstReceived },
    ];

    for (const segment of segments) {
      const existing = this.stageTotals.get(segment.stage) ?? { totalMs: 0, count: 0 };
      this.stageTotals.set(segment.stage, {
        totalMs: existing.totalMs + segment.ms,
        count: existing.count + 1,
      });
    }

    const largest = segments.reduce((max, segment) =>
      segment.ms > max.ms ? segment : max,
    );

    const averages = Object.fromEntries(
      [...this.stageTotals.entries()].map(([stage, stats]) => [
        stage,
        Math.round(stats.totalMs / stats.count),
      ]),
    );

    logInfo("turn_timing_largest_delay", {
      callSid,
      stage: largest.stage,
      delayMs: largest.ms,
      speechStoppedToFirstAudioMs:
        firstReceived !== undefined && speechStopped !== undefined
          ? firstReceived - speechStopped
          : undefined,
      stageAveragesMs: averages,
    });
  }
}
