import { logInfo } from "../logger.js";

export type TurnTimingMilestone =
  | "speech_stopped"
  | "transcript_completed"
  | "caller_turn_processed"
  | "structured_state_updated"
  | "next_question_selected"
  | "response_requested"
  | "response_create_sent"
  | "first_audio_received"
  | "first_audio_sent_to_twilio";

type StageSegment = {
  stage: string;
  ms: number;
};

export class TurnTimingTracker {
  private turnStartedAt: number | null = null;
  private turnId: number | null = null;
  private readonly marks = new Map<TurnTimingMilestone, number>();
  private readonly stageTotals = new Map<string, { totalMs: number; count: number }>();

  beginTurn(callSid?: string, turnId?: number): void {
    this.turnStartedAt = Date.now();
    this.turnId = turnId ?? null;
    this.marks.clear();
    logInfo("turn_timing_reset", { callSid, turnId });
  }

  getTurnId(): number | null {
    return this.turnId;
  }

  isStaleTurn(turnId: number | null | undefined): boolean {
    if (turnId === null || turnId === undefined || this.turnId === null) {
      return false;
    }

    return turnId !== this.turnId;
  }

  hasFirstAudio(): boolean {
    return this.marks.has("first_audio_received");
  }

  record(
    milestone: TurnTimingMilestone,
    callSid?: string,
    options: { turnId?: number | null } = {},
  ): void {
    if (this.isStaleTurn(options.turnId)) {
      return;
    }

    if (this.turnStartedAt === null) {
      this.beginTurn(callSid, options.turnId ?? undefined);
    }

    if (this.marks.has(milestone)) {
      return;
    }

    const now = Date.now();
    this.marks.set(milestone, now);
    const speechStopped = this.marks.get("speech_stopped");

    logInfo("turn_timing", {
      callSid,
      turnId: this.turnId,
      milestone,
      elapsedMs: now - (this.turnStartedAt ?? now),
      elapsedFromSpeechStoppedMs:
        speechStopped !== undefined ? now - speechStopped : undefined,
      caller_speech_stopped_at: this.marks.get("speech_stopped"),
      final_transcript_at: this.marks.get("transcript_completed"),
      caller_turn_processed_at: this.marks.get("caller_turn_processed"),
      state_updated_at: this.marks.get("structured_state_updated"),
      next_question_selected_at: this.marks.get("next_question_selected"),
      response_requested_at: this.marks.get("response_requested"),
      response_create_sent_at: this.marks.get("response_create_sent"),
      first_audio_delta_at: this.marks.get("first_audio_received"),
      first_audio_sent_to_twilio_at: this.marks.get("first_audio_sent_to_twilio"),
    });

    if (milestone === "first_audio_sent_to_twilio") {
      this.recordStageSegments(callSid);
    }
  }

  private recordStageSegments(callSid?: string): void {
    const speechStopped = this.marks.get("speech_stopped");
    const transcriptCompleted = this.marks.get("transcript_completed");
    const callerTurnProcessed = this.marks.get("caller_turn_processed");
    const structuredUpdated = this.marks.get("structured_state_updated");
    const responseRequested = this.marks.get("response_requested");
    const responseCreateSent = this.marks.get("response_create_sent");
    const firstReceived = this.marks.get("first_audio_received");
    const firstSent = this.marks.get("first_audio_sent_to_twilio");

    if (
      speechStopped === undefined ||
      transcriptCompleted === undefined ||
      callerTurnProcessed === undefined ||
      structuredUpdated === undefined ||
      responseRequested === undefined ||
      responseCreateSent === undefined ||
      firstReceived === undefined ||
      firstSent === undefined
    ) {
      return;
    }

    const segments: StageSegment[] = [
      { stage: "speech_stopped_to_transcript", ms: transcriptCompleted - speechStopped },
      { stage: "transcript_to_turn_processed", ms: callerTurnProcessed - transcriptCompleted },
      { stage: "turn_processed_to_state_updated", ms: structuredUpdated - callerTurnProcessed },
      { stage: "state_updated_to_response_requested", ms: responseRequested - structuredUpdated },
      { stage: "response_requested_to_create_sent", ms: responseCreateSent - responseRequested },
      { stage: "response_create_to_first_audio", ms: firstReceived - responseCreateSent },
      { stage: "first_audio_to_twilio_send", ms: firstSent - firstReceived },
    ];

    for (const segment of segments) {
      const existing = this.stageTotals.get(segment.stage) ?? { totalMs: 0, count: 0 };
      this.stageTotals.set(segment.stage, {
        totalMs: existing.totalMs + segment.ms,
        count: existing.count + 1,
      });
    }

    const speechStoppedToFirstAudioMs = firstReceived - speechStopped;

    logInfo("turn_timing_summary", {
      callSid,
      turnId: this.turnId,
      speechStoppedToFirstAudioMs,
      speechStoppedToTranscriptMs: transcriptCompleted - speechStopped,
      transcriptToResponseCreateMs: responseCreateSent - transcriptCompleted,
      responseCreateToFirstAudioMs: firstReceived - responseCreateSent,
      stageAveragesMs: this.getStageAveragesMs(),
    });
  }

  getStageAveragesMs(): Record<string, number> {
    return Object.fromEntries(
      [...this.stageTotals.entries()].map(([stage, stats]) => [
        stage,
        Math.round(stats.totalMs / stats.count),
      ]),
    );
  }

  getSpeechStoppedToFirstAudioMs(): number | undefined {
    const speechStopped = this.marks.get("speech_stopped");
    const firstReceived = this.marks.get("first_audio_received");

    if (speechStopped === undefined || firstReceived === undefined) {
      return undefined;
    }

    return firstReceived - speechStopped;
  }
}
