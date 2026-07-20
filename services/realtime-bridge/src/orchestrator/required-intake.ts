import type { RealtimeFields } from "./realtime-prompts.js";
import { normalizeCallbackPhoneE164 } from "./callback-phone.js";
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

function isCallbackComplete(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed === true;
}

function isFieldComplete(field: RequiredFieldKey, fields: RealtimeFields): boolean {
  switch (field) {
    case "full_name":
      return hasValue(fields.full_name);
    case "callback_phone":
      return isCallbackComplete(fields);
    case "address":
      return hasValue(fields.address);
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
      return hasValue(fields.appointment_preference);
    case "photos_available":
      return !isStructuredBooleanUnset(fields.photos_available);
    default:
      return false;
  }
}

/** Deterministic gate — summary/closing blocked while this returns any item. */
export function getMissingRequiredFields(fields: RealtimeFields): RequiredFieldKey[] {
  return REQUIRED_FIELD_ORDER.filter((field) => !isFieldComplete(field, fields));
}

export function isRequiredIntakeComplete(fields: RealtimeFields): boolean {
  return getMissingRequiredFields(fields).length === 0;
}

export function getNextRequiredField(fields: RealtimeFields): RequiredFieldKey | null {
  return getMissingRequiredFields(fields)[0] ?? null;
}

const FIELD_QUESTIONS: Record<RequiredFieldKey, string> = {
  problem_description: "What's going on with the roof?",
  full_name: "What's your name?",
  callback_phone: "What's the best callback number?",
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference: "What's the best time for the roofing team to reach you?",
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
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference: "What's the best time for the roofing team to reach you?",
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
): RealtimeFields {
  const trimmed = answer.trim();

  if (!trimmed) {
    return fields;
  }

  const target = getNextRequiredField(fields);

  if (!target) {
    return fields;
  }

  let updated: RealtimeFields = { ...fields };

  switch (target) {
    case "full_name":
      if (!hasValue(updated.full_name)) {
        updated.full_name = trimmed.slice(0, 100);
      }
      break;
    case "address":
      if (!hasValue(updated.address)) {
        updated.address = trimmed.slice(0, 500);
      }
      break;
    case "problem_description":
      if (!hasValue(updated.problem_description)) {
        updated.problem_description = trimmed.slice(0, 500);
      }
      break;
    case "urgency":
      if (!hasValue(updated.urgency)) {
        updated.urgency = trimmed.slice(0, 200);
      }
      break;
    case "appointment_preference":
      if (!hasValue(updated.appointment_preference)) {
        updated.appointment_preference = trimmed.slice(0, 200);
      }
      break;
    case "emergency_or_active_leak":
    case "insurance_claim_started":
    case "adjuster_contacted":
    case "photos_available": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null) {
        updated[target] = parsed;
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
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed !== true;
}
