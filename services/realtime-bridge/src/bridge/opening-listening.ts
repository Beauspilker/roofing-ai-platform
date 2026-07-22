import {
  extractDamageOrCallReason,
  extractExplicitCallerName,
  isLikelyCallReasonSpeech,
  isPlausibleCallerName,
  validateCallerNameCandidate,
} from "../orchestrator/field-validation.js";
import { normalizeCallReasonFromSpeech } from "../orchestrator/call-reason-handling.js";
import { isSpelledNameSpeech } from "../orchestrator/caller-name-intake.js";
import type { RealtimeFields } from "../orchestrator/realtime-prompts.js";
import {
  REALTIME_OPENING_GREETING,
  REALTIME_OPENING_NAME_QUESTION,
  REALTIME_OPENING_QUESTION,
} from "../orchestrator/realtime-prompts.js";

export const OPENING_SILENCE_FIRST_REPROMPT_MS = 6_000;
export const OPENING_SILENCE_SECOND_REPROMPT_MS = 6_000;
export const OPENING_SILENCE_HANGUP_MS = 8_000;

export const OPENING_STILL_THERE_PROMPT = "Are you still there?";
export const OPENING_READY_REPROMPT =
  "I'm here whenever you're ready. Could I start with your first and last name?";
export const OPENING_SILENCE_GOODBYE =
  "It sounds like we may have lost the connection. Thanks for calling Beau's Roofing. Have a great day.";

const OPENING_ECHO_PATTERN =
  /\b(thank you for calling|beau'?s roofing|ai assistant|how can i help you today|how can we help you today)\b/i;

const OPENING_FILLER_PATTERN =
  /^(hi|hello|hey|yes|yeah|yep|ok|okay|thanks|thank you|uh|um|hmm)\.?$/i;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAssistantOpeningEchoTranscript(speech: string): boolean {
  const normalized = speech.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized === REALTIME_OPENING_QUESTION.trim().toLowerCase()) {
    return true;
  }

  if (normalized === REALTIME_OPENING_NAME_QUESTION.trim().toLowerCase()) {
    return true;
  }

  if (OPENING_ECHO_PATTERN.test(normalized)) {
    return true;
  }

  const greetingNormalized = REALTIME_OPENING_GREETING.trim().toLowerCase();
  if (
    greetingNormalized.includes(normalized) ||
    normalized.includes("how can i help you today")
  ) {
    return true;
  }

  return false;
}

export function isMeaningfulOpeningCallerTranscript(
  speech: string,
  options: { awaitingName?: boolean } = {},
): boolean {
  const trimmed = speech.trim();

  if (trimmed.length < 2) {
    return false;
  }

  if (isAssistantOpeningEchoTranscript(trimmed)) {
    return false;
  }

  if (OPENING_FILLER_PATTERN.test(trimmed)) {
    return false;
  }

  if (isSpelledNameSpeech(trimmed)) {
    return true;
  }

  if (extractExplicitCallerName(trimmed)) {
    return true;
  }

  const validated = validateCallerNameCandidate(trimmed, {
    isDirectNameAnswer: true,
    allowDirectNameWithoutIntro: true,
  });
  if (validated.value && isPlausibleCallerName(validated.value)) {
    return true;
  }

  if (options.awaitingName !== true) {
    if (extractDamageOrCallReason(trimmed)) {
      return true;
    }

    if (isLikelyCallReasonSpeech(trimmed)) {
      return true;
    }

    return trimmed.split(/\s+/).length >= 4;
  }

  return trimmed.length >= 2;
}

export function resolveCallReasonFromSpeech(speech: string): string | null {
  return normalizeCallReasonFromSpeech(speech);
}

export function canAdvanceAfterOpening(
  fields: RealtimeFields,
  options: {
    hasReceivedMeaningfulCallerTranscript?: boolean;
    awaitingName?: boolean;
  } = {},
): boolean {
  if (options.hasReceivedMeaningfulCallerTranscript !== true) {
    return false;
  }

  if (options.awaitingName === true) {
    return Boolean(fields.caller_first_name?.trim() || fields.full_name?.trim());
  }

  return hasValue(fields.problem_description);
}

export type OpeningSilenceStage = 0 | 1 | 2 | 3;

export type OpeningSilencePrompt =
  | typeof OPENING_STILL_THERE_PROMPT
  | typeof OPENING_READY_REPROMPT
  | typeof OPENING_SILENCE_GOODBYE;

export class OpeningSilenceController {
  private listeningForReason = false;
  private meaningfulTranscriptReceived = false;
  private silenceStage: OpeningSilenceStage = 0;
  private silenceTimer: NodeJS.Timeout | null = null;

  isListeningForReason(): boolean {
    return this.listeningForReason && !this.meaningfulTranscriptReceived;
  }

  hasReceivedMeaningfulCallerTranscript(): boolean {
    return this.meaningfulTranscriptReceived;
  }

  getSilenceStage(): OpeningSilenceStage {
    return this.silenceStage;
  }

  beginListeningForReason(): void {
    this.listeningForReason = true;
    this.meaningfulTranscriptReceived = false;
    this.silenceStage = 0;
    this.clearSilenceTimer();
  }

  onMeaningfulCallerTranscript(): void {
    this.meaningfulTranscriptReceived = true;
    this.listeningForReason = false;
    this.clearSilenceTimer();
  }

  reset(): void {
    this.listeningForReason = false;
    this.meaningfulTranscriptReceived = false;
    this.silenceStage = 0;
    this.clearSilenceTimer();
  }

  scheduleSilenceCheck(onPrompt: (prompt: OpeningSilencePrompt) => void): void {
    if (!this.isListeningForReason()) {
      return;
    }

    this.clearSilenceTimer();

    const delayMs =
      this.silenceStage === 0
        ? OPENING_SILENCE_FIRST_REPROMPT_MS
        : this.silenceStage === 1
          ? OPENING_SILENCE_SECOND_REPROMPT_MS
          : OPENING_SILENCE_HANGUP_MS;

    this.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(onPrompt);
    }, delayMs);
  }

  private handleSilenceTimeout(onPrompt: (prompt: OpeningSilencePrompt) => void): void {
    if (!this.isListeningForReason()) {
      return;
    }

    if (this.silenceStage === 0) {
      this.silenceStage = 1;
      onPrompt(OPENING_STILL_THERE_PROMPT);
      return;
    }

    if (this.silenceStage === 1) {
      this.silenceStage = 2;
      onPrompt(OPENING_READY_REPROMPT);
      return;
    }

    this.silenceStage = 3;
    onPrompt(OPENING_SILENCE_GOODBYE);
  }

  clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
