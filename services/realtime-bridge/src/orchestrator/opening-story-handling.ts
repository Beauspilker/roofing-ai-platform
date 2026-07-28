import { appendContextNote } from "./field-completion.js";
import { normalizeCallReasonFromSpeech } from "./call-reason-handling.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import { isCallerNameResolved } from "./required-intake.js";

export const OPENING_STORY_BROAD_FOLLOWUP =
  "Can you tell me a little more about what happened?";

export const OPENING_STORY_PARSE_FALLBACK =
  "I'm sorry, I didn't catch all of that. Could you briefly tell me what happened with the roof?";

const VAGUE_OPENING_PATTERNS = [
  /^i need (?:a )?(?:roof )?(?:repair|inspection|estimate|replacement)\.?$/i,
  /^i have (?:storm|hail|wind|roof) damage\.?$/i,
  /^i(?:'ve| have) got (?:storm|hail|wind|roof) damage\.?$/i,
  /^my roof (?:is )?(?:leaking|damaged)\.?$/i,
  /^i need (?:a )?(?:new )?roof\.?$/i,
  /^(?:roof )?(?:repair|damage|leak)\.?$/i,
];

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isVagueOpeningStory(speech: string): boolean {
  const trimmed = speech.trim();

  if (!trimmed) {
    return false;
  }

  for (const pattern of VAGUE_OPENING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  const wordCount = trimmed.split(/\s+/).length;
  const reason = normalizeCallReasonFromSpeech(trimmed);

  if (
    reason &&
    wordCount <= 6 &&
    !/\b(leak|water|address|insurance|adjuster|tomorrow|urgent|kitchen|bedroom|ceiling)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

export function countRichOpeningCapture(fields: RealtimeFields): number {
  let count = 0;

  if (hasValue(fields.problem_description)) {
    count += 1;
  }

  if (hasValue(fields.full_name) || hasValue(fields.caller_first_name)) {
    count += 1;
  }

  if (hasValue(fields.callback_phone)) {
    count += 1;
  }

  if (hasValue(fields.address)) {
    count += 1;
  }

  if (fields.emergency_or_active_leak === true) {
    count += 1;
  }

  if (hasValue(fields.urgency)) {
    count += 1;
  }

  if (fields.insurance_claim_started !== undefined && fields.insurance_claim_started !== null) {
    count += 1;
  }

  if (hasValue(fields.appointment_preference_raw) || hasValue(fields.appointment_preference)) {
    count += 1;
  }

  return count;
}

export function needsOpeningStoryBroadFollowUp(
  fields: RealtimeFields,
  speech: string,
): boolean {
  if ((fields.opening_story_followup_attempts ?? 0) >= 1) {
    return false;
  }

  if (!hasValue(fields.problem_description)) {
    return false;
  }

  return isVagueOpeningStory(speech) && countRichOpeningCapture(fields) <= 1;
}

export function needsOpeningStoryParseFallback(
  fields: RealtimeFields,
  speech: string,
): boolean {
  if ((fields.opening_story_followup_attempts ?? 0) >= 1) {
    return false;
  }

  const trimmed = speech.trim();

  if (!trimmed) {
    return true;
  }

  if (hasValue(fields.problem_description)) {
    return false;
  }

  return countRichOpeningCapture(fields) === 0;
}

export function needsOpeningStoryClarification(
  fields: RealtimeFields,
  speech: string,
): boolean {
  if ((fields.opening_story_followup_attempts ?? 0) >= 1) {
    return false;
  }

  if (needsOpeningStoryParseFallback(fields, speech)) {
    return true;
  }

  if (needsOpeningStoryBroadFollowUp(fields, speech)) {
    return true;
  }

  if (isCallerNameResolved(fields) && !hasValue(fields.problem_description)) {
    return true;
  }

  return false;
}

export function buildOpeningStoryClarificationReply(
  fields: RealtimeFields,
  speech: string,
): string {
  if (needsOpeningStoryParseFallback(fields, speech)) {
    return OPENING_STORY_PARSE_FALLBACK;
  }

  return OPENING_STORY_BROAD_FOLLOWUP;
}

export function markOpeningStoryFollowupAttempt(fields: RealtimeFields): RealtimeFields {
  return {
    ...fields,
    opening_story_followup_attempts: (fields.opening_story_followup_attempts ?? 0) + 1,
  };
}

export function preserveOpeningStoryTranscript(
  fields: RealtimeFields,
  speech: string,
): RealtimeFields {
  const trimmed = speech.trim();

  if (!trimmed) {
    return fields;
  }

  return appendContextNote(fields, trimmed);
}
