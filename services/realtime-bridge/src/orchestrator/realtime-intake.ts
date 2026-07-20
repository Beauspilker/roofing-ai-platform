import { mergeCallerAnswer, type CollectedFields } from "../../../../lib/call-intake.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import { REALTIME_ANYTHING_ELSE_QUESTION } from "./realtime-prompts.js";
import {
  applyStructuredBoolean,
  insuranceClaimIsStarted,
  isStructuredBooleanUnset,
  parseExplicitBoolean,
  shouldCollectAdjuster,
  syncLegacyStringFields,
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

const STAGE_FIELD_KEYS: Record<RealtimeIntakeStage, keyof RealtimeFields> = {
  problem: "problem_description",
  full_name: "full_name",
  callback_phone: "callback_phone",
  address: "address",
  project_type: "project_type",
  active_leak: "active_leak",
  storm_damage: "storm_damage",
  insurance_claim: "insurance_claim",
  adjuster_contacted: "adjuster_contacted",
  urgency: "urgency",
  appointment: "appointment_preference",
  photos_available: "photos_available",
};

const STAGE_BOOLEAN_FIELDS: Partial<Record<RealtimeIntakeStage, StructuredBooleanField>> = {
  active_leak: "emergency_or_active_leak",
  insurance_claim: "insurance_claim_started",
  adjuster_contacted: "adjuster_contacted",
  photos_available: "photos_available",
};

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isStageComplete(stage: RealtimeIntakeStage, fields: RealtimeFields): boolean {
  const booleanField = STAGE_BOOLEAN_FIELDS[stage];

  if (booleanField) {
    return !isStructuredBooleanUnset(fields[booleanField]);
  }

  const fieldKey = STAGE_FIELD_KEYS[stage];
  const value = fields[fieldKey];

  return typeof value === "string" && hasValue(value);
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

function applyStageBooleanAnswer(
  fields: RealtimeFields,
  stage: RealtimeIntakeStage,
  answer: string,
): RealtimeFields {
  const booleanField = STAGE_BOOLEAN_FIELDS[stage];

  if (!booleanField) {
    return fields;
  }

  return applyStructuredBoolean(fields, booleanField, answer, {
    isDirectAnswer: true,
  });
}

export function mergeRealtimeCallerAnswer(
  fields: RealtimeFields,
  answer: string,
  callerPhone?: string,
): RealtimeFields {
  const stage = getRealtimeNextMissingStage(fields);
  let updated = { ...fields };
  const processed = answer.trim();

  if (stage !== "wrap_up" && processed) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    const booleanField = STAGE_BOOLEAN_FIELDS[stage];

    if (booleanField) {
      updated = applyStageBooleanAnswer(updated, stage, processed);
    } else if (!hasValue(updated[fieldKey] as string | undefined)) {
      if (
        stage === "callback_phone" &&
        callerPhone &&
        /^(yes|yeah|yep|correct|this one|that one)\b/i.test(processed)
      ) {
        updated[fieldKey] = callerPhone;
      } else {
        updated[fieldKey] = processed.slice(0, 500);
      }
    }
  }

  if (stage !== "wrap_up") {
    const stageIndex = REALTIME_INTAKE_STAGES.indexOf(stage);
    const libMerged = mergeCallerAnswer(fields, answer, callerPhone) as RealtimeFields;

    for (let index = 0; index < stageIndex; index += 1) {
      const priorStage = REALTIME_INTAKE_STAGES[index];
      const priorBoolean = STAGE_BOOLEAN_FIELDS[priorStage];

      if (priorBoolean) {
        if (isStructuredBooleanUnset(updated[priorBoolean])) {
          const parsed = parseExplicitBoolean(processed);
          if (parsed !== null) {
            updated[priorBoolean] = parsed;
          }
        }
        continue;
      }

      const fieldKey = STAGE_FIELD_KEYS[priorStage];
      const extractedValue = libMerged[fieldKey];

      if (!hasValue(updated[fieldKey] as string | undefined) && hasValue(extractedValue)) {
        updated[fieldKey] = extractedValue;
      }
    }
  }

  if (detectEmergency(processed)) {
    updated.emergency_or_active_leak = updated.emergency_or_active_leak ?? true;
    updated.urgency = updated.urgency ?? "emergency";
    updated.emergency_acknowledged = true;
  }

  return syncLegacyStringFields(updated);
}

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
      return "What's the property address?";
    case "project_type":
      return "Is this a repair, replacement, inspection, or storm damage?";
    case "active_leak":
      return "Any water getting inside right now?";
    case "storm_damage":
      return "Was this from recent storm damage?";
    case "insurance_claim":
      return "Have you started an insurance claim?";
    case "adjuster_contacted":
      return "Have you contacted your adjuster yet?";
    case "urgency":
      return fields.emergency_or_active_leak === true
        ? "How soon do you need someone out?"
        : "How soon would you like someone to take a look?";
    case "appointment":
      return "What day or time works best for a visit?";
    case "photos_available":
      return "Do you have photos of the damage?";
    default:
      return REALTIME_ANYTHING_ELSE_QUESTION;
  }
}

export function buildRealtimeAcknowledgement(
  answeredStage: RealtimeIntakeStage,
  answer: string,
  fields: RealtimeFields,
): string | null {
  if (detectEmergency(answer) && !fields.emergency_acknowledged) {
    return "Got it — I'll flag this as urgent.";
  }

  if (answeredStage === "full_name" || answeredStage === "callback_phone") {
    return "Thanks.";
  }

  return "Got it.";
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

export function toPersistedFields(fields: RealtimeFields): CollectedFields {
  return syncLegacyStringFields(fields);
}

export { insuranceClaimIsStarted, shouldCollectAdjuster };
