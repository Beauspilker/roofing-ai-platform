import type { RealtimeFields } from "../orchestrator/realtime-prompts.js";
import {
  getNaturalTransitionQuestion,
  getNextRequiredField,
} from "../orchestrator/required-intake.js";
import { REALTIME_ANYTHING_ELSE_QUESTION } from "../orchestrator/realtime-prompts.js";

export type StallCategory =
  | "transcript_extraction_stalled"
  | "extraction_no_response_requested"
  | "response_create_stalled"
  | "response_audio_stalled"
  | "response_audio_incomplete"
  | "websocket_interrupted"
  | "stale_response_lock";

export const EXTRACTION_STALL_MS = 5_000;
export const RESPONSE_CREATE_STALL_MS = 2_000;
export const AUDIO_COMPLETION_STALL_MS = 15_000;
export const MAX_STALL_RECOVERY_ATTEMPTS = 3;

export const STALL_RECOVERY_PROMPT = "Sorry about that—I'm still here.";
export const STALL_REPEAT_PROMPT =
  "Thanks for your patience. Could you repeat that last answer for me?";

export function buildStallRecoveryReply(
  fields: RealtimeFields,
  callerPhone: string | undefined,
  attempt: number,
): string {
  const prefix = attempt <= 1 ? STALL_RECOVERY_PROMPT : STALL_REPEAT_PROMPT;
  const next = getNextRequiredField(fields);

  if (!next) {
    return `${prefix} ${REALTIME_ANYTHING_ELSE_QUESTION}`;
  }

  const question = getNaturalTransitionQuestion(next, fields, callerPhone);
  return `${prefix} ${question}`;
}

export class StallRecoveryController {
  private recoveryAttempts = 0;
  private extractionTimer: NodeJS.Timeout | null = null;
  private audioCompletionTimer: NodeJS.Timeout | null = null;
  private watchedTurnId: number | null = null;

  getRecoveryAttempts(): number {
    return this.recoveryAttempts;
  }

  canAttemptRecovery(): boolean {
    return this.recoveryAttempts < MAX_STALL_RECOVERY_ATTEMPTS;
  }

  recordRecoveryAttempt(): number {
    this.recoveryAttempts += 1;
    return this.recoveryAttempts;
  }

  resetRecoveryAttempts(): void {
    this.recoveryAttempts = 0;
  }

  beginExtractionWatch(
    turnId: number,
    onStall: (category: StallCategory) => void,
  ): void {
    this.clearExtractionWatch();
    this.watchedTurnId = turnId;
    this.extractionTimer = setTimeout(() => {
      if (this.watchedTurnId === turnId) {
        onStall("transcript_extraction_stalled");
      }
    }, EXTRACTION_STALL_MS);
  }

  completeExtraction(): void {
    this.clearExtractionWatch();
  }

  clearExtractionWatch(): void {
    if (this.extractionTimer) {
      clearTimeout(this.extractionTimer);
      this.extractionTimer = null;
    }
    this.watchedTurnId = null;
  }

  beginAudioCompletionWatch(
    turnId: number,
    onStall: (category: StallCategory) => void,
  ): void {
    this.clearAudioCompletionWatch();
    this.audioCompletionTimer = setTimeout(() => {
      onStall("response_audio_incomplete");
    }, AUDIO_COMPLETION_STALL_MS);
  }

  clearAudioCompletionWatch(): void {
    if (this.audioCompletionTimer) {
      clearTimeout(this.audioCompletionTimer);
      this.audioCompletionTimer = null;
    }
  }
}
