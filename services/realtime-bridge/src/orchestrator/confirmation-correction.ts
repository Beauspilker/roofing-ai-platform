import type { PendingQuestionKey } from "./pending-question.js";
import {
  extractCallbackPhoneFromSpeech,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import { formatAddressForSpeech, hasConfirmableAddress } from "./address-confirmation.js";
import {
  extractExplicitCallerName,
  isPlausibleCallerName,
  validateCallerNameCandidate,
} from "./field-validation.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export type ConfirmableFieldKey =
  | "caller_name"
  | "callback_phone"
  | "service_address"
  | "preferred_callback_time"
  | "schedule_confirmation";

const REJECTION_ONLY_PATTERN =
  /^(no|nope|nah|not quite|incorrect|wrong|that's wrong|thats wrong|that is wrong|not right)\.?$/i;

const REJECTION_PREFIX_PATTERN =
  /^(?:no|nope|nah|not quite|incorrect|wrong|that's wrong|thats wrong|that is wrong|not right|no[, ]+actually|actually|i meant|not[, ]+it'?s|not[, ]+it is)(?:[, ]|$)/i;

const REJECTION_INLINE_PATTERN =
  /^(?:no|nope|nah|not quite|incorrect|wrong|that's wrong|thats wrong|that is wrong|not right|no[, ]+actually|actually|i meant|not[, ]+it'?s|not[, ]+it is)\b[, ]*/i;

export function isRejectionOnlySpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  return REJECTION_ONLY_PATTERN.test(normalized);
}

export function isRejectionPrefixedSpeech(speech: string): boolean {
  const normalized = speech.trim();

  if (!normalized) {
    return false;
  }

  return REJECTION_PREFIX_PATTERN.test(normalized.toLowerCase()) || isRejectionOnlySpeech(normalized);
}

export function stripRejectionPrefix(speech: string): string {
  let remaining = speech.trim();

  while (remaining) {
    const next = remaining.replace(REJECTION_INLINE_PATTERN, "").trim();
    if (next === remaining) {
      break;
    }
    remaining = next;
  }

  return remaining.replace(/^[, ]+/, "").trim();
}

export function buildCorrectionFollowUp(pendingQuestion: PendingQuestionKey | null): string {
  switch (pendingQuestion) {
    case "caller_name":
      return "Thanks for correcting me. What's the correct name?";
    case "callback_phone":
    case "callback_confirmation":
      return "Thanks for correcting me. What's the correct callback number?";
    case "service_address":
    case "address_confirmation":
      return "Thanks for correcting me. What's the correct address?";
    case "preferred_callback_time":
    case "schedule_confirmation":
      return "Thanks for correcting me. What day and time should I put down?";
    default:
      return "Thanks for correcting me. Could you repeat that?";
  }
}

export function parseCallerNameCorrection(speech: string): string | null {
  const stripped = stripRejectionPrefix(speech);

  if (!stripped || isRejectionOnlySpeech(stripped)) {
    return null;
  }

  const explicit = extractExplicitCallerName(stripped);
  if (explicit) {
    return explicit;
  }

  const validated = validateCallerNameCandidate(stripped, {
    isDirectNameAnswer: true,
    allowDirectNameWithoutIntro: true,
  });

  return validated.value;
}

export function parseAddressCorrection(speech: string): string | null {
  const stripped = stripRejectionPrefix(speech);

  if (!stripped || isRejectionOnlySpeech(stripped)) {
    return null;
  }

  const labeledMatch = stripped.match(
    /\b(?:address is|the address is|it'?s|it is|at|to)\s+(.+)/i,
  );
  const candidate = (labeledMatch?.[1] ?? stripped).trim();

  if (!candidate || !/\d/.test(candidate) || candidate.length < 8) {
    return null;
  }

  return formatAddressForSpeech(candidate.slice(0, 500));
}

export function parseCallbackPhoneCorrection(
  speech: string,
  callerPhone?: string,
  currentPhone?: string,
): string | null {
  const stripped = stripRejectionPrefix(speech);

  if (!stripped || isRejectionOnlySpeech(stripped)) {
    return null;
  }

  const explicit = extractCallbackPhoneFromSpeech(stripped, callerPhone, {
    allowAffirmativeReuse: false,
  });

  if (explicit) {
    return normalizeCallbackPhoneE164(explicit);
  }

  const endsInMatch = stripped.match(
    /\b(?:ends in|ending in|last four(?: digits)?(?: are| is)?)\s*(\d{4})\b/i,
  );

  if (endsInMatch?.[1]) {
    const baseDigits = (currentPhone ?? callerPhone ?? "").replace(/\D/g, "").slice(-10);

    if (baseDigits.length === 10) {
      return normalizeCallbackPhoneE164(`${baseDigits.slice(0, 6)}${endsInMatch[1]}`);
    }
  }

  return null;
}

export function parseScheduleCorrectionSpeech(speech: string): string {
  return stripRejectionPrefix(speech);
}

export function requiresImmediateConfirmation(
  field: ConfirmableFieldKey,
  fields: RealtimeFields = {},
): boolean {
  switch (field) {
    case "callback_phone":
    case "schedule_confirmation":
    case "preferred_callback_time":
      return true;
    case "caller_name":
      return fields.name_needs_clarification === true || fields.name_awaiting_repeat === true;
    case "service_address":
      return fields.address_needs_confirmation === true;
    default:
      return false;
  }
}

export function shouldReadBackAddressImmediately(fields: RealtimeFields): boolean {
  if (!hasConfirmableAddress(fields.address)) {
    return false;
  }

  if (fields.address_confirmed === true) {
    return false;
  }

  return fields.address_needs_confirmation === true;
}

export function markAddressCaptured(fields: RealtimeFields, address: string): RealtimeFields {
  const formatted = formatAddressForSpeech(address);
  const ambiguous =
    !/\d/.test(formatted) ||
    formatted.split(/\s+/).length < 3 ||
    /\b(main street|main st|somewhere|around here|over there)\b/i.test(formatted);

  return {
    ...fields,
    address: formatted,
    address_confirmed: ambiguous ? false : true,
    address_needs_confirmation: ambiguous,
  };
}

export function blocksGenericAnswerReadback(pendingQuestion: PendingQuestionKey | null): boolean {
  return (
    pendingQuestion === "reason_for_call" ||
    pendingQuestion === "call_reason" ||
    pendingQuestion === "insurance_claim" ||
    pendingQuestion === "adjuster_contacted" ||
    pendingQuestion === "active_leak" ||
    pendingQuestion === "urgency" ||
    pendingQuestion === "additional_notes"
  );
}
