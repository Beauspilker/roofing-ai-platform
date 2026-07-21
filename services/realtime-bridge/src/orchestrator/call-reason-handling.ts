import {
  extractDamageOrCallReason,
  extractExplicitCallerName,
  isLikelyCallReasonSpeech,
} from "./field-validation.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import type { PendingQuestionKey } from "./pending-question.js";

export const CALL_REASON_CLARIFICATION_PROMPT =
  "I'm sorry, I didn't quite catch what you're calling about. Could you tell me again?";

export const CALL_REASON_NO_RESPONSE_PROMPT =
  "No problem—what can the roofing team help you with?";

const CALLING_FOR_PATTERN =
  /\b(?:i'?m|i am|we'?re|we are)\s+calling(?:\s+(?:for|about|regarding))?\s+(.+)/i;

const CALLING_ABOUT_PATTERN =
  /\bcalling(?:\s+(?:for|about|regarding))?\s+(.+)/i;

const SHORT_YES_NO_PATTERN =
  /^(yes|yeah|yep|yup|no|nope|nah|not really|correct|right)\.?$/i;

const SUPPORTED_REASON_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\bhail(?:\s+damage)?\b/i, value: "hail damage" },
  { pattern: /\bstorm(?:\s+damage)?\b/i, value: "storm damage" },
  { pattern: /\broof(?:\s+)?leak(?:ing)?\b/i, value: "roof leak" },
  { pattern: /\broof(?:\s+)?damage\b/i, value: "roof damage" },
  { pattern: /\bmissing\s+shingles?\b/i, value: "missing shingles" },
  { pattern: /\btree(?:\s+fell|\s+damage| damage)\b/i, value: "tree damage" },
  { pattern: /\bgutter(?:\s+problem|\s+issue|\s+damage)?\b/i, value: "gutter problem" },
  { pattern: /\broof(?:\s+)?inspection\b/i, value: "roof inspection" },
  { pattern: /\broof(?:\s+)?replacement\b/i, value: "roof replacement" },
  { pattern: /\bestimate\b/i, value: "estimate" },
  { pattern: /\binsurance(?:\s+damage|\s+claim)?\b/i, value: "insurance damage" },
];

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPendingCallReasonQuestion(
  pendingQuestion: PendingQuestionKey | null | undefined,
): boolean {
  return pendingQuestion === "call_reason";
}

export function isShortYesNoReasonAnswer(speech: string): boolean {
  return SHORT_YES_NO_PATTERN.test(speech.trim());
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/g, "").trim();
}

function extractReasonPhrase(text: string): string {
  const trimmed = stripTrailingPunctuation(text.trim());

  const callingFor = trimmed.match(CALLING_FOR_PATTERN);
  if (callingFor?.[1]) {
    return stripTrailingPunctuation(callingFor[1]);
  }

  const callingAbout = trimmed.match(CALLING_ABOUT_PATTERN);
  if (callingAbout?.[1]) {
    return stripTrailingPunctuation(callingAbout[1]);
  }

  return trimmed;
}

export function normalizeCallReasonLabel(text: string): string {
  const phrase = extractReasonPhrase(text);
  const lower = phrase.toLowerCase();

  for (const { pattern, value } of SUPPORTED_REASON_PATTERNS) {
    if (pattern.test(lower)) {
      return value;
    }
  }

  return phrase.slice(0, 500);
}

export function normalizeCallReasonFromSpeech(speech: string): string | null {
  const trimmed = speech.trim();

  if (!trimmed || isShortYesNoReasonAnswer(trimmed)) {
    return null;
  }

  const phrase = extractReasonPhrase(trimmed);
  const extracted = extractDamageOrCallReason(phrase) ?? extractDamageOrCallReason(trimmed);

  if (extracted) {
    return normalizeCallReasonLabel(extracted);
  }

  if (isLikelyCallReasonSpeech(trimmed) || isLikelyCallReasonSpeech(phrase)) {
    return normalizeCallReasonLabel(phrase);
  }

  return null;
}

export function buildCallReasonClarificationPrompt(): string {
  return CALL_REASON_CLARIFICATION_PROMPT;
}

export function buildCallReasonNoResponsePrompt(): string {
  return CALL_REASON_NO_RESPONSE_PROMPT;
}

export type CallReasonCaptureResult = {
  fields: RealtimeFields;
  resolved: boolean;
  needsClarification: boolean;
};

export function applyCallReasonCapture(
  fields: RealtimeFields,
  speech: string,
): CallReasonCaptureResult {
  const trimmed = speech.trim();
  let updated: RealtimeFields = {
    ...fields,
    pending_question: "call_reason",
  };

  if (!trimmed) {
    return { fields: updated, resolved: false, needsClarification: true };
  }

  if (isShortYesNoReasonAnswer(trimmed)) {
    updated = {
      ...updated,
      call_reason_awaiting_clarification: true,
      call_reason_clarification_attempts:
        (updated.call_reason_clarification_attempts ?? 0) + 1,
    };
    return { fields: updated, resolved: false, needsClarification: true };
  }

  const reason = normalizeCallReasonFromSpeech(trimmed);

  if (!reason) {
    updated = {
      ...updated,
      call_reason_awaiting_clarification: true,
      call_reason_clarification_attempts:
        (updated.call_reason_clarification_attempts ?? 0) + 1,
    };
    return { fields: updated, resolved: false, needsClarification: true };
  }

  updated = {
    ...updated,
    problem_description: reason,
    call_reason_awaiting_clarification: false,
    name_pending_confirmation: undefined,
    name_awaiting_repeat: undefined,
  };

  const volunteeredName = extractExplicitCallerName(trimmed);
  if (volunteeredName && !hasValue(updated.full_name)) {
    updated.full_name = volunteeredName;
  }

  return { fields: updated, resolved: true, needsClarification: false };
}

export function resolveCallReasonClarificationReply(
  fields: RealtimeFields,
  speech: string,
): string {
  if (isShortYesNoReasonAnswer(speech) && /^(no|nope|nah|not really)\.?$/i.test(speech.trim())) {
    return buildCallReasonNoResponsePrompt();
  }

  const attempts = fields.call_reason_clarification_attempts ?? 0;

  if (attempts >= 2) {
    return buildCallReasonNoResponsePrompt();
  }

  return buildCallReasonClarificationPrompt();
}
