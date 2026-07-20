import type { CollectedFields } from "../../../../lib/call-intake.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import type { AcknowledgmentPolicy } from "./acknowledgment-policy.js";
import { sanitizeIntakeReply } from "./acknowledgment-policy.js";
import {
  buildCallbackReadbackConfirmation,
  extractCallbackPhoneFromSpeech,
  isCompanyPhoneNumber,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import {
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "./multi-field-extraction.js";
import { REALTIME_ANYTHING_ELSE_QUESTION } from "./realtime-prompts.js";
import {
  isStructuredBooleanUnset,
  normalizeTriStateField,
  shouldCollectAdjuster,
  syncLegacyStringFields,
  toCollectedFields,
  type StructuredBooleanField,
} from "./structured-intake.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export const REALTIME_INTAKE_STAGES = [
  "problem",
  "full_name",
  "callback_phone",
  "address",
  "project_type",
  "active_leak",
  "storm_damage",
  "insurance_claim",
  "adjuster_contacted",
  "urgency",
  "appointment",
  "photos_available",
] as const;

export type RealtimeIntakeStage = (typeof REALTIME_INTAKE_STAGES)[number];

const STAGE_BOOLEAN_FIELDS: Partial<Record<RealtimeIntakeStage, StructuredBooleanField>> = {
  active_leak: "emergency_or_active_leak",
  insurance_claim: "insurance_claim_started",
  adjuster_contacted: "adjuster_contacted",
  photos_available: "photos_available",
};

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isCallbackStageComplete(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed === true;
}

function isStageComplete(stage: RealtimeIntakeStage, fields: RealtimeFields): boolean {
  if (stage === "callback_phone") {
    return isCallbackStageComplete(fields);
  }

  const booleanField = STAGE_BOOLEAN_FIELDS[stage];

  if (booleanField) {
    return !isStructuredBooleanUnset(fields[booleanField]);
  }

  switch (stage) {
    case "problem":
      return hasValue(fields.problem_description);
    case "full_name":
      return hasValue(fields.full_name);
    case "address":
      return hasValue(fields.address);
    case "project_type":
      return hasValue(fields.project_type);
    case "storm_damage":
      return hasValue(fields.storm_damage);
    case "urgency":
      return hasValue(fields.urgency);
    case "appointment":
      return hasValue(fields.appointment_preference);
    default:
      return false;
  }
}

export function isRealtimeIntakeComplete(fields: RealtimeFields): boolean {
  return getRealtimeNextMissingStage(fields) === "wrap_up";
}

export function getRealtimeNextMissingStage(
  fields: RealtimeFields,
): RealtimeIntakeStage | "wrap_up" {
  for (const stage of REALTIME_INTAKE_STAGES) {
    if (stage === "adjuster_contacted" && !shouldCollectAdjuster(fields)) {
      continue;
    }

    if (!isStageComplete(stage, fields)) {
      return stage;
    }
  }

  return "wrap_up";
}

export function needsCallbackReadback(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed !== true;
}

export function mergeRealtimeCallerAnswer(
  fields: RealtimeFields,
  answer: string,
  callerPhone?: string,
): RealtimeFields {
  const extracted = extractAllFieldsFromTranscript(answer, callerPhone);
  return mergeExtractedFields(fields, extracted);
}

export function applyCallbackCorrection(
  fields: RealtimeFields,
  speech: string,
  callerPhone?: string,
): RealtimeFields {
  const phone = extractCallbackPhoneFromSpeech(speech, callerPhone);

  if (!phone || isCompanyPhoneNumber(phone)) {
    return fields;
  }

  return syncLegacyStringFields({
    ...fields,
    callback_phone: normalizeCallbackPhoneE164(phone),
    callback_phone_confirmed: false,
  });
}

export function confirmCallbackPhone(fields: RealtimeFields): RealtimeFields {
  return syncLegacyStringFields({
    ...fields,
    callback_phone_confirmed: true,
  });
}

const STAGE_TRANSITIONS: Partial<Record<RealtimeIntakeStage, string>> = {
  address: "Next, what's the property address?",
  project_type: "Is this a repair, replacement, inspection, or storm damage?",
  active_leak: "Any water getting inside right now?",
  storm_damage: "Was this from recent storm damage?",
  insurance_claim: "Have you started an insurance claim?",
  adjuster_contacted: "One more thing—have you contacted an adjuster?",
  urgency: "And how urgent is the issue?",
  appointment: "What day or time works best for a visit?",
  photos_available: "Do you have photos of the damage?",
};

export function getRealtimeStageQuestion(
  stage: RealtimeIntakeStage,
  fields: RealtimeFields = {},
  callerPhone?: string,
): string {
  const firstName = fields.full_name?.trim().split(/\s+/)[0];

  switch (stage) {
    case "problem":
      return "What's going on with the roof?";
    case "full_name":
      return "What's your name?";
    case "callback_phone":
      if (firstName && callerPhone) {
        return `${firstName}, is this the best number to reach you?`;
      }
      return callerPhone
        ? "Is this the best number to reach you?"
        : "What's the best callback number?";
    case "address":
    case "project_type":
    case "active_leak":
    case "storm_damage":
    case "insurance_claim":
    case "adjuster_contacted":
    case "urgency":
    case "appointment":
    case "photos_available":
      return STAGE_TRANSITIONS[stage] ?? "What's the next detail?";
    default:
      return REALTIME_ANYTHING_ELSE_QUESTION;
  }
}

export function buildRealtimeAcknowledgment(
  policy: AcknowledgmentPolicy,
  answer: string,
  fields: RealtimeFields,
  filledCount: number,
): string | null {
  return policy.selectAcknowledgment({
    isEmergency: detectEmergency(answer),
    emergencyAlreadyAcknowledged: fields.emergency_acknowledged === true,
    fieldsFilledCount: filledCount,
  });
}

export function buildIntakeReply(
  policy: AcknowledgmentPolicy,
  fields: RealtimeFields,
  answer: string,
  callerPhone: string | undefined,
  filledCount: number,
): string {
  const nextStage = getRealtimeNextMissingStage(fields);
  const ack = buildRealtimeAcknowledgment(policy, answer, fields, filledCount);
  const question = getRealtimeStageQuestion(
    nextStage === "wrap_up" ? "photos_available" : nextStage,
    fields,
    callerPhone,
  );

  if (!ack) {
    return sanitizeIntakeReply(question);
  }

  return sanitizeIntakeReply(`${ack} ${question}`.replace(/\s+/g, " ").trim());
}

export function appendAnythingElseNotes(
  fields: RealtimeFields,
  speech: string,
): RealtimeFields {
  const trimmed = speech.trim();

  if (!trimmed || isAnythingElseDeclined(trimmed)) {
    return fields;
  }

  const existing = fields.additional_notes?.trim();
  const combined = existing ? `${existing} ${trimmed}` : trimmed;

  return syncLegacyStringFields({
    ...fields,
    additional_notes: combined.slice(0, 500),
  });
}

function isAnythingElseDeclined(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /^(no|nope|nah|nothing|none|that's all|thats all|that is all|i'm good|im good|all set|nothing else)\b/.test(
      normalized,
    ) || normalized.includes("nothing else")
  );
}

export function countNewlyFilledFields(
  before: RealtimeFields,
  after: RealtimeFields,
): number {
  let count = 0;

  for (const key of [
    "problem_description",
    "full_name",
    "callback_phone",
    "address",
    "project_type",
    "urgency",
    "appointment_preference",
    "storm_damage",
  ] as const) {
    if (!hasValue(before[key]) && hasValue(after[key])) {
      count += 1;
    }
  }

  for (const key of [
    "insurance_claim_started",
    "adjuster_contacted",
    "photos_available",
    "emergency_or_active_leak",
  ] as const) {
    if (isStructuredBooleanUnset(before[key]) && !isStructuredBooleanUnset(after[key])) {
      count += 1;
    }
  }

  return count;
}

export function normalizeRealtimeFields(fields: RealtimeFields): RealtimeFields {
  return {
    ...fields,
    insurance_claim_started:
      fields.insurance_claim_started ??
      normalizeTriStateField(fields.insurance_claim),
    adjuster_contacted: normalizeTriStateField(fields.adjuster_contacted),
    photos_available: normalizeTriStateField(fields.photos_available),
    emergency_or_active_leak:
      fields.emergency_or_active_leak ?? normalizeTriStateField(fields.active_leak),
  };
}

export function toPersistedFields(fields: RealtimeFields): CollectedFields {
  return toCollectedFields(normalizeRealtimeFields(fields));
}

export { buildCallbackReadbackConfirmation, shouldCollectAdjuster };
