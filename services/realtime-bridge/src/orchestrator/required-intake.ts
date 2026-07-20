import type { RealtimeFields } from "./realtime-prompts.js";
import { normalizeCallbackPhoneE164 } from "./callback-phone.js";
import { isAddressConfirmed } from "./address-confirmation.js";
import {
  EARLY_CALLER_NAME_QUESTION,
  extractDamageOrCallReason,
  isCallerNameDeclinedSpeech,
  isCallerNameUnavailableSpeech,
  isPlausibleCallerName,
  isPlausibleServiceAddress,
  validateCallerNameCandidate,
} from "./field-validation.js";
import { isPhotosFieldComplete } from "./photos-field.js";
import { isScheduleComplete } from "./schedule-normalizer.js";
import { needsCallbackConfirmation, mapRequiredFieldToPending } from "./pending-question.js";
import {
  isStructuredBooleanUnset,
  parseExplicitBoolean,
  syncLegacyStringFields,
} from "./structured-intake.js";

export type RequiredFieldKey =
  | "full_name"
  | "callback_phone"
  | "address"
  | "problem_description"
  | "urgency"
  | "emergency_or_active_leak"
  | "insurance_claim_started"
  | "adjuster_contacted"
  | "appointment_preference"
  | "photos_available";

/** Shared completion gate keys used before summary/closing. */
export type SharedMissingFieldKey =
  | "callerName"
  | "callbackPhone"
  | "serviceAddress"
  | "callReason"
  | "issueDetails"
  | "urgencyStatus"
  | "safetyStatus"
  | "callbackSchedule"
  | "additionalNotes";

/** Priority order for the next intake question. Code-owned — not model judgment. */
export const REQUIRED_FIELD_ORDER: RequiredFieldKey[] = [
  "problem_description",
  "full_name",
  "callback_phone",
  "address",
  "emergency_or_active_leak",
  "urgency",
  "insurance_claim_started",
  "adjuster_contacted",
  "appointment_preference",
  "photos_available",
];

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isCallerNameResolved(fields: RealtimeFields): boolean {
  if (fields.caller_name_declined === true || fields.caller_name_unavailable === true) {
    return true;
  }

  return hasValue(fields.full_name) && isPlausibleCallerName(fields.full_name ?? "");
}

function isAdditionalNotesResolved(fields: RealtimeFields): boolean {
  return fields.additional_notes_responded === true;
}

function mapRequiredFieldToShared(field: RequiredFieldKey): SharedMissingFieldKey {
  switch (field) {
    case "full_name":
      return "callerName";
    case "callback_phone":
      return "callbackPhone";
    case "address":
      return "serviceAddress";
    case "problem_description":
      return "callReason";
    case "urgency":
      return "urgencyStatus";
    case "emergency_or_active_leak":
      return "safetyStatus";
    case "appointment_preference":
      return "callbackSchedule";
    default:
      return "issueDetails";
  }
}

function isCallbackComplete(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed === true;
}

function isFieldComplete(field: RequiredFieldKey, fields: RealtimeFields): boolean {
  switch (field) {
    case "full_name":
      return isCallerNameResolved(fields);
    case "callback_phone":
      return isCallbackComplete(fields);
    case "address":
      return isAddressConfirmed(fields);
    case "problem_description":
      return hasValue(fields.problem_description);
    case "urgency":
      return hasValue(fields.urgency);
    case "emergency_or_active_leak":
      return !isStructuredBooleanUnset(fields.emergency_or_active_leak);
    case "insurance_claim_started":
      return !isStructuredBooleanUnset(fields.insurance_claim_started);
    case "adjuster_contacted":
      if (fields.insurance_claim_started !== true) {
        return true;
      }
      return !isStructuredBooleanUnset(fields.adjuster_contacted);
    case "appointment_preference":
      return isScheduleComplete(fields);
    case "photos_available":
      return isPhotosFieldComplete(fields);
    default:
      return false;
  }
}

/** Deterministic gate — summary/closing blocked while this returns any item. */
export function getMissingRequiredFields(fields: RealtimeFields): RequiredFieldKey[] {
  return REQUIRED_FIELD_ORDER.filter((field) => !isFieldComplete(field, fields));
}

/** Shared completion gate — blocks summary/closing until every shared field is resolved. */
export function getSharedMissingFields(fields: RealtimeFields): SharedMissingFieldKey[] {
  const missing = new Set<SharedMissingFieldKey>();

  if (!isCallerNameResolved(fields)) {
    missing.add("callerName");
  }

  for (const field of getMissingRequiredFields(fields)) {
    missing.add(mapRequiredFieldToShared(field));
  }

  if (!isAdditionalNotesResolved(fields)) {
    missing.add("additionalNotes");
  }

  return [...missing];
}

export function isSharedIntakeComplete(fields: RealtimeFields): boolean {
  return getSharedMissingFields(fields).length === 0;
}

export function isRequiredIntakeComplete(fields: RealtimeFields): boolean {
  return getMissingRequiredFields(fields).length === 0 && isAdditionalNotesResolved(fields);
}

export function getNextRequiredField(fields: RealtimeFields): RequiredFieldKey | null {
  return getMissingRequiredFields(fields)[0] ?? null;
}

const FIELD_QUESTIONS: Record<RequiredFieldKey, string> = {
  problem_description: "What's going on with the roof?",
  full_name: EARLY_CALLER_NAME_QUESTION,
  callback_phone: "What's the best callback number?",
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference:
    "What day and time would be best for the roofing team to contact you?",
  photos_available: "Do you have photos of the damage?",
};

export function getRequiredFieldQuestion(
  field: RequiredFieldKey,
  fields: RealtimeFields,
  callerPhone?: string,
): string {
  const firstName = fields.full_name?.trim().split(/\s+/)[0];

  if (field === "callback_phone" && callerPhone) {
    if (firstName) {
      return `${firstName}, is this the best number to reach you?`;
    }
    return "Is this the best number to reach you?";
  }

  return FIELD_QUESTIONS[field];
}

const CONTEXTUAL_TRANSITIONS: Partial<Record<RequiredFieldKey, string>> = {
  full_name: EARLY_CALLER_NAME_QUESTION,
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference:
    "What day and time would be best for the roofing team to contact you?",
  photos_available: "Do you have photos of the damage?",
};

export function getNaturalTransitionQuestion(
  field: RequiredFieldKey,
  fields: RealtimeFields,
  callerPhone?: string,
): string {
  if (field === "callback_phone") {
    return getRequiredFieldQuestion(field, fields, callerPhone);
  }

  return CONTEXTUAL_TRANSITIONS[field] ?? getRequiredFieldQuestion(field, fields, callerPhone);
}

export function applyDirectAnswerToMissingField(
  fields: RealtimeFields,
  answer: string,
  callerPhone?: string,
  pendingQuestion: import("./pending-question.js").PendingQuestionKey | null = null,
): RealtimeFields {
  const trimmed = answer.trim();

  if (!trimmed) {
    return fields;
  }

  const target = getNextRequiredField(fields);

  if (!target) {
    return fields;
  }

  if (pendingQuestion !== null && pendingQuestion !== mapRequiredFieldToPending(target)) {
    return fields;
  }

  let updated: RealtimeFields = { ...fields };

  switch (target) {
    case "full_name": {
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
    case "address":
      if (!hasValue(updated.address) && isPlausibleServiceAddress(trimmed)) {
        updated.address = trimmed.slice(0, 500);
        updated.address_confirmed = false;
      }
      break;
    case "problem_description":
      if (!hasValue(updated.problem_description)) {
        updated.problem_description =
          extractDamageOrCallReason(trimmed) ?? trimmed.slice(0, 500);
      }
      break;
    case "urgency":
      if (!hasValue(updated.urgency)) {
        updated.urgency = trimmed.slice(0, 200);
      }
      break;
    case "appointment_preference":
      if (!hasValue(updated.appointment_preference_raw)) {
        updated.appointment_preference_raw = trimmed.slice(0, 200);
        updated.schedule_confirmed = false;
      }
      break;
    case "emergency_or_active_leak":
    case "insurance_claim_started":
    case "adjuster_contacted": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null) {
        updated[target] = parsed;
      }
      break;
    }
    case "photos_available": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null && !isPhotosFieldComplete(updated)) {
        updated.photos_available = parsed;
        updated.pending_question = undefined;
      }
      break;
    }
    case "callback_phone":
      if (/^(yes|yeah|yep|correct|this one|that one|same number)\b/i.test(trimmed) && callerPhone) {
        updated.callback_phone = normalizeCallbackPhoneE164(callerPhone);
        updated.callback_phone_confirmed = false;
      }
      break;
    default:
      break;
  }

  return syncLegacyStringFields(updated);
}

export function needsCallbackReadback(fields: RealtimeFields): boolean {
  return needsCallbackConfirmation(fields);
}
