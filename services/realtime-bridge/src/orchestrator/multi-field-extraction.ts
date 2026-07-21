import { detectEmergency } from "../../../../lib/call-intelligence.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import {
  extractCallbackPhoneFromSpeech,
  isCallbackConfirmed,
  isCallbackRejected,
  isCompanyPhoneNumber,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import {
  confirmAddress,
  isAddressConfirmedSpeech,
  isAddressRejectedSpeech,
} from "./address-confirmation.js";
import {
  extractDamageOrCallReason,
  extractExplicitCallerName,
  isCallerNameDeclinedSpeech,
  isCallerNameUnavailableSpeech,
  isPlausibleCallerName,
  isPlausibleServiceAddress,
  validateCallerNameCandidate,
} from "./field-validation.js";
import { isCallerNameResolved } from "./required-intake.js";
import { preserveConfirmedFieldState } from "./safe-field-merge.js";
import type { PendingQuestionKey } from "./pending-question.js";
import {
  allowsBooleanDirectAnswer,
  allowsCallbackAffirmativeReuse,
} from "./pending-question.js";
import {
  parseExplicitBoolean,
  syncLegacyStringFields,
} from "./structured-intake.js";

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Short answers that must route only through pendingQuestion. */
export function isShortPendingStyleAnswer(speech: string): boolean {
  const normalized = speech
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(yes|yeah|yep|yup|correct|right|no|nope|nah|not yet|i did|i have|i haven't|i havent|haven't|havent)$/i.test(
    normalized,
  );
}

function shouldExtractCallbackPhone(
  pendingQuestion: PendingQuestionKey | null,
  speech: string,
): boolean {
  if (pendingQuestion === "callback_phone" || pendingQuestion === "callback_confirmation") {
    return true;
  }

  return !isShortPendingStyleAnswer(speech);
}

function extractInsuranceClaim(speech: string, pending: PendingQuestionKey | null): boolean | null {
  if (allowsBooleanDirectAnswer(pending, "insurance_claim")) {
    return parseExplicitBoolean(speech);
  }

  if (/\b(insurance|claim)\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }

  return null;
}

function extractAdjusterContact(speech: string, pending: PendingQuestionKey | null): boolean | null {
  if (allowsBooleanDirectAnswer(pending, "adjuster_contacted")) {
    return parseExplicitBoolean(speech);
  }

  if (/\badjuster\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }

  return null;
}

function extractActiveLeak(speech: string, pending: PendingQuestionKey | null): boolean | null {
  if (allowsBooleanDirectAnswer(pending, "active_leak")) {
    return parseExplicitBoolean(speech);
  }

  if (/\b(leak|water|drip|flooding|getting inside|active leak)\b/i.test(speech)) {
    const parsed = parseExplicitBoolean(speech);
    if (parsed !== null) {
      return parsed;
    }

    if (/no.*(leak|water)|isn't.*(leak|water)|not.*(leak|water)/i.test(speech)) {
      return false;
    }

    if (/water.*(inside|getting in)|active leak|leaking inside/i.test(speech)) {
      return true;
    }
  }

  return null;
}

function extractAddressFromSpeech(speech: string): string | null {
  const streetMatch = speech.match(
    /\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80}(?:\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|place|pl)\b)?/i,
  );

  if (streetMatch && isPlausibleServiceAddress(streetMatch[0])) {
    return streetMatch[0].trim();
  }

  const atMatch = speech.match(/\bat\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,60})/i);
  const candidate = atMatch?.[1]?.trim();

  if (candidate && isPlausibleServiceAddress(candidate)) {
    return candidate;
  }

  return null;
}

export function extractAllFieldsFromTranscript(
  speech: string,
  callerPhone?: string,
  pendingQuestion: PendingQuestionKey | null = null,
): Partial<RealtimeFields> {
  const trimmed = speech.trim();

  if (!trimmed) {
    return {};
  }

  const extracted: Partial<RealtimeFields> = {};

  const explicitName = extractExplicitCallerName(trimmed);
  if (explicitName) {
    extracted.full_name = explicitName;
  }

  const damage = extractDamageOrCallReason(trimmed);
  if (damage) {
    extracted.problem_description = damage;
  }

  const address = extractAddressFromSpeech(trimmed);
  if (address) {
    extracted.address = address;
  }

  const callbackPhone = shouldExtractCallbackPhone(pendingQuestion, trimmed)
    ? extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
        allowAffirmativeReuse: allowsCallbackAffirmativeReuse(pendingQuestion),
      })
    : null;

  if (callbackPhone) {
    extracted.callback_phone = callbackPhone;
  }

  const insurance = extractInsuranceClaim(trimmed, pendingQuestion);
  if (insurance !== null) {
    extracted.insurance_claim_started = insurance;
  }

  const adjuster = extractAdjusterContact(trimmed, pendingQuestion);
  if (adjuster !== null) {
    extracted.adjuster_contacted = adjuster;
  }

  const leak = extractActiveLeak(trimmed, pendingQuestion);
  if (leak !== null) {
    extracted.emergency_or_active_leak = leak;
  }

  if (detectEmergency(trimmed)) {
    extracted.urgency = extracted.urgency ?? "emergency";
    if (/water.*(inside|getting in|coming into)|active leak|leaking inside|flooding/i.test(trimmed)) {
      extracted.emergency_or_active_leak = extracted.emergency_or_active_leak ?? true;
      extracted.emergency_acknowledged = true;
    }
  }

  return extracted;
}

export function mergeExtractedFields(
  fields: RealtimeFields,
  extracted: Partial<RealtimeFields>,
): RealtimeFields {
  let updated: RealtimeFields = { ...fields };

  if (
    hasValue(extracted.full_name) &&
    isPlausibleCallerName(extracted.full_name!) &&
    !hasValue(updated.full_name)
  ) {
    updated.full_name = extracted.full_name!.trim().slice(0, 100);
  }

  if (hasValue(extracted.problem_description) && !hasValue(updated.problem_description)) {
    updated.problem_description = extracted.problem_description!.trim().slice(0, 500);
  }

  if (
    hasValue(extracted.address) &&
    isPlausibleServiceAddress(extracted.address!) &&
    !hasValue(updated.address)
  ) {
    updated.address = extracted.address!.trim().slice(0, 500);
    updated.address_confirmed = false;
  }

  if (hasValue(extracted.callback_phone)) {
    const normalized = normalizeCallbackPhoneE164(extracted.callback_phone!);

    if (!isCompanyPhoneNumber(normalized)) {
      const sameNumber = updated.callback_phone === normalized;

      if (!sameNumber) {
        updated.callback_phone = normalized;
        updated.callback_phone_confirmed = false;
      }
    }
  }

  if (extracted.insurance_claim_started !== undefined && extracted.insurance_claim_started !== null) {
    updated.insurance_claim_started = extracted.insurance_claim_started;
  }

  if (extracted.adjuster_contacted !== undefined && extracted.adjuster_contacted !== null) {
    updated.adjuster_contacted = extracted.adjuster_contacted;
  }

  if (
    extracted.emergency_or_active_leak !== undefined &&
    extracted.emergency_or_active_leak !== null
  ) {
    updated.emergency_or_active_leak = extracted.emergency_or_active_leak;
  }

  if (extracted.emergency_acknowledged) {
    updated.emergency_acknowledged = true;
  }

  return preserveConfirmedFieldState(fields, syncLegacyStringFields(updated));
}

export function applyAnswerForPendingQuestion(
  fields: RealtimeFields,
  answer: string,
  callerPhone: string | undefined,
  pendingQuestion: PendingQuestionKey | null,
): RealtimeFields {
  const trimmed = answer.trim();

  if (!trimmed || !pendingQuestion) {
    return fields;
  }

  let updated: RealtimeFields = { ...fields };

  switch (pendingQuestion) {
    case "caller_name": {
      if (isCallerNameDeclinedSpeech(trimmed)) {
        updated.caller_name_declined = true;
        updated.full_name = undefined;
        updated.name_needs_clarification = false;
        break;
      }

      if (isCallerNameUnavailableSpeech(trimmed)) {
        updated.caller_name_unavailable = true;
        updated.full_name = undefined;
        updated.name_needs_clarification = false;
        break;
      }

      if (!isCallerNameResolved(updated)) {
        const validated = validateCallerNameCandidate(trimmed, { isDirectNameAnswer: true });
        if (validated.value) {
          updated.full_name = validated.value.slice(0, 100);
          updated.name_needs_clarification = false;
          updated.caller_name_declined = false;
          updated.caller_name_unavailable = false;
        } else if (validated.needsClarification) {
          updated.name_needs_clarification = true;
          updated.name_clarification_attempts =
            (updated.name_clarification_attempts ?? 0) + 1;
        }
      }
      break;
    }
    case "call_reason":
      if (!hasValue(updated.problem_description)) {
        const damage = extractDamageOrCallReason(trimmed);
        if (damage) {
          updated.problem_description = damage;
        }
      }
      break;
    case "callback_confirmation": {
      if (isCallbackConfirmed(trimmed)) {
        updated.callback_phone_confirmed = true;
      } else if (isCallbackRejected(trimmed)) {
        break;
      } else {
        const phone = extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
          allowAffirmativeReuse: true,
        });
        if (phone && !isCompanyPhoneNumber(phone)) {
          updated.callback_phone = phone;
          updated.callback_phone_confirmed = false;
        }
      }
      break;
    }
    case "address_confirmation": {
      if (isAddressConfirmedSpeech(trimmed)) {
        updated = confirmAddress(updated);
      } else if (isAddressRejectedSpeech(trimmed)) {
        break;
      }
      break;
    }
    case "callback_phone":
      if (/^(yes|yeah|yep|correct|this one|that one|same number)\b/i.test(trimmed) && callerPhone) {
        updated.callback_phone = normalizeCallbackPhoneE164(callerPhone);
        updated.callback_phone_confirmed = false;
      } else {
        const phone = extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
          allowAffirmativeReuse: true,
        });
        if (phone && !isCompanyPhoneNumber(phone)) {
          updated.callback_phone = phone;
          updated.callback_phone_confirmed = false;
        }
      }
      break;
    case "service_address":
      if (!hasValue(updated.address)) {
        if (isPlausibleServiceAddress(trimmed)) {
          updated.address = trimmed.slice(0, 500);
          updated.address_confirmed = false;
        }
      }
      break;
    case "insurance_claim":
    case "adjuster_contacted":
    case "active_leak": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null) {
        const fieldMap = {
          insurance_claim: "insurance_claim_started",
          adjuster_contacted: "adjuster_contacted",
          active_leak: "emergency_or_active_leak",
        } as const;
        updated[fieldMap[pendingQuestion]] = parsed;
      }
      break;
    }
    case "urgency":
      if (!hasValue(updated.urgency)) {
        updated.urgency = trimmed.slice(0, 200);
      }
      break;
    case "preferred_callback_time":
      updated.appointment_preference_raw = trimmed.slice(0, 200);
      updated.schedule_confirmed = false;
      updated.schedule_pending_clarification = false;
      break;
    default:
      break;
  }

  return preserveConfirmedFieldState(fields, syncLegacyStringFields(updated));
}

/** @deprecated Use applyAnswerForPendingQuestion */
export const applyPendingQuestionAnswer = applyAnswerForPendingQuestion;
