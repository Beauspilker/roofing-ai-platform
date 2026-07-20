import type { CollectedFields } from "../../../../lib/call-intake.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export type TriStateBoolean = boolean | null;

export type StructuredBooleanField =
  | "insurance_claim_started"
  | "adjuster_contacted"
  | "photos_available"
  | "emergency_or_active_leak";

const EXPLICIT_YES =
  /^(yes|yeah|yep|yup|sure|correct|right|already|i have|i did|i've|we have|we've)\b/i;

const EXPLICIT_NO =
  /^(no|nope|nah|not yet|haven't|havent|have not|none|negative|i haven't|i have not|we haven't|we have not)\b/i;

const NOT_YET = /\bnot yet\b/i;

export function parseCorrectionBoolean(speech: string): TriStateBoolean {
  const normalized = speech.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    /\b(not yet|haven't started|have not started|haven't|have not|no claim)\b/.test(
      normalized,
    ) &&
    !/\b(actually|wrong|incorrect|correction|did start|started a claim|have started)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  if (
    /\b(yes|yeah|yep|i did start|i have started|we started|already started|did start a claim|started a claim|started the claim)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /^(no|nope|nah)\b/.test(normalized) &&
    !/\b(wrong|incorrect|actually|correction)\b/.test(normalized)
  ) {
    return false;
  }

  return parseExplicitBoolean(speech);
}

/** Parse an explicit yes/no from caller speech. Returns null when unknown. */
export function parseExplicitBoolean(speech: string): TriStateBoolean {
  const normalized = speech.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (NOT_YET.test(normalized) || EXPLICIT_NO.test(normalized)) {
    return false;
  }

  if (EXPLICIT_YES.test(normalized)) {
    return true;
  }

  return null;
}

export function applyStructuredBoolean(
  fields: RealtimeFields,
  field: StructuredBooleanField,
  speech: string,
  options: { isDirectAnswer: boolean; allowCorrection?: boolean },
): RealtimeFields {
  const parsed = parseExplicitBoolean(speech);
  const current = fields[field] ?? null;

  if (parsed === null) {
    return fields;
  }

  if (!options.isDirectAnswer && current !== null) {
    return fields;
  }

  if (current !== null && !options.allowCorrection && !options.isDirectAnswer) {
    return fields;
  }

  if (current === parsed && !options.allowCorrection) {
    return fields;
  }

  return {
    ...fields,
    [field]: parsed,
  };
}

export function insuranceClaimIsStarted(fields: RealtimeFields): boolean {
  return fields.insurance_claim_started === true;
}

export function shouldCollectAdjuster(fields: RealtimeFields): boolean {
  return fields.insurance_claim_started === true;
}

export function isStructuredBooleanUnset(value: TriStateBoolean | undefined): boolean {
  return value === undefined || value === null;
}

export function booleanFieldSpokenLine(
  field: StructuredBooleanField,
  value: TriStateBoolean,
): string {
  switch (field) {
    case "insurance_claim_started":
      if (value === true) {
        return "You've already started an insurance claim.";
      }
      if (value === false) {
        return "You haven't started an insurance claim yet.";
      }
      return "We didn't confirm whether an insurance claim has been started.";
    case "adjuster_contacted":
      if (value === true) {
        return "You've already contacted your adjuster.";
      }
      if (value === false) {
        return "You haven't contacted your adjuster yet.";
      }
      return "We didn't confirm whether you've contacted your adjuster.";
    case "photos_available":
      if (value === true) {
        return "You have photos of the damage.";
      }
      if (value === false) {
        return "You don't have photos of the damage yet.";
      }
      return "We didn't confirm whether you have photos of the damage.";
    case "emergency_or_active_leak":
      if (value === true) {
        return "There is active water intrusion or an emergency.";
      }
      if (value === false) {
        return "There isn't active water intrusion right now.";
      }
      return "We didn't confirm whether there's active water intrusion.";
    default:
      return "";
  }
}

export function syncLegacyStringFields(fields: RealtimeFields): RealtimeFields {
  return { ...fields };
}

export function toCollectedFields(fields: RealtimeFields): CollectedFields {
  return {
    ...fields,
    insurance_claim: triStateToLegacyString(fields.insurance_claim_started),
    adjuster_contacted: triStateToLegacyString(normalizeTriState(fields.adjuster_contacted)),
    photos_available: triStateToLegacyString(normalizeTriState(fields.photos_available)),
    active_leak: triStateToLegacyString(fields.emergency_or_active_leak),
  };
}

export function normalizeTriStateField(
  value: TriStateBoolean | string | undefined,
): TriStateBoolean {
  return normalizeTriState(value);
}

function normalizeTriState(value: TriStateBoolean | string | undefined): TriStateBoolean {
  if (value === true || value === false || value === null) {
    return value;
  }

  if (value === "yes") {
    return true;
  }

  if (value === "no") {
    return false;
  }

  return null;
}

function triStateToLegacyString(value: TriStateBoolean | undefined): string | undefined {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return undefined;
}

export function applyCorrectionToStructuredField(
  fields: RealtimeFields,
  speech: string,
): RealtimeFields {
  let updated = { ...fields };
  const normalized = speech.toLowerCase();

  if (/insurance|claim/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.insurance_claim_started = parsed;
    }
  }

  if (/adjuster/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.adjuster_contacted = parsed;
    }
  }

  if (/photo|picture|image/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.photos_available = parsed;
    }
  }

  if (/leak|water|emergency|urgent/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.emergency_or_active_leak = parsed;
    }
  }

  return syncLegacyStringFields(updated);
}
