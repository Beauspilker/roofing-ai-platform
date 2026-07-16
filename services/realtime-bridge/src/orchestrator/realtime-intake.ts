import {
  mergeCallerAnswer,
  type CollectedFields,
} from "../../../../lib/call-intake.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import {
  REALTIME_ANYTHING_ELSE_QUESTION,
  type RealtimeFields,
} from "./realtime-prompts.js";

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

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function insuranceClaimStarted(fields: RealtimeFields): boolean {
  const claim = fields.insurance_claim?.toLowerCase() ?? "";

  return /yes|started|filed|claim|insurance|already/i.test(claim);
}

function shouldCollectAdjuster(fields: RealtimeFields): boolean {
  return insuranceClaimStarted(fields);
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

    const fieldKey = STAGE_FIELD_KEYS[stage];
    const value = fields[fieldKey];

    if (typeof value !== "string" || !hasValue(value)) {
      return stage;
    }
  }

  return "wrap_up";
}

function extractYesNoUnknown(text: string): string | null {
  const normalized = text.toLowerCase().trim();

  if (/^(yes|yeah|yep|yup|sure|correct|already|i have|i did)\b/.test(normalized)) {
    return "yes";
  }

  if (/^(no|nope|nah|not yet|haven't|havent|none)\b/.test(normalized)) {
    return "no";
  }

  if (/don't know|not sure|unknown/i.test(normalized)) {
    return "unknown";
  }

  return null;
}

function extractPhotosAvailability(text: string): string | null {
  const yesNo = extractYesNoUnknown(text);

  if (yesNo) {
    return yesNo;
  }

  if (/photo|picture|image/i.test(text)) {
    return text.trim();
  }

  return null;
}

function mergeRealtimeExtras(
  fields: RealtimeFields,
  answer: string,
  stage: RealtimeIntakeStage | "wrap_up",
): RealtimeFields {
  let updated = { ...fields };

  if (stage === "adjuster_contacted" || !hasValue(updated.adjuster_contacted)) {
    const adjuster = extractYesNoUnknown(answer);
    if (adjuster && shouldCollectAdjuster(updated)) {
      updated.adjuster_contacted = adjuster;
    }
  }

  if (stage === "photos_available" || !hasValue(updated.photos_available)) {
    const photos = extractPhotosAvailability(answer);
    if (photos) {
      updated.photos_available = photos;
    }
  }

  return updated;
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

    if (!hasValue(updated[fieldKey])) {
      if (stage === "callback_phone" && callerPhone && /^(yes|yeah|yep|correct|this one|that one)\b/i.test(processed)) {
        updated[fieldKey] = callerPhone;
      } else if (
        stage === "adjuster_contacted" ||
        stage === "photos_available" ||
        stage === "active_leak" ||
        stage === "storm_damage" ||
        stage === "insurance_claim"
      ) {
        updated[fieldKey] =
          (stage === "photos_available"
            ? extractPhotosAvailability(processed)
            : extractYesNoUnknown(processed)) ?? processed.slice(0, 120);
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
      const fieldKey = STAGE_FIELD_KEYS[priorStage];
      const extractedValue = libMerged[fieldKey];

      if (!hasValue(updated[fieldKey]) && hasValue(extractedValue)) {
        updated[fieldKey] = extractedValue;
      }
    }
  }

  updated = mergeRealtimeExtras(updated, processed, stage);

  if (detectEmergency(processed)) {
    updated.urgency = updated.urgency ?? "emergency";
    updated.emergency_acknowledged = true;
  }

  return updated;
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
      return fields.active_leak === "yes"
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

  if (answeredStage === "problem" && /urgent|emergency|leak|water|tree|hole/i.test(answer)) {
    return "Understood.";
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

  if (!trimmed) {
    return fields;
  }

  const existing = fields.additional_notes?.trim();
  const combined = existing ? `${existing} ${trimmed}` : trimmed;

  return {
    ...fields,
    additional_notes: combined.slice(0, 500),
  };
}

export function toPersistedFields(fields: RealtimeFields): CollectedFields {
  return fields;
}
