import { extractFieldsFromSpeech } from "../../../../lib/call-intake.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import {
  extractCallbackPhoneFromSpeech,
  isCompanyPhoneNumber,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import {
  parseCorrectionBoolean,
  parseExplicitBoolean,
  syncLegacyStringFields,
} from "./structured-intake.js";

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeStringField(
  current: string | undefined,
  extracted: string | undefined,
): string | undefined {
  if (!hasValue(extracted)) {
    return current;
  }

  return extracted!.trim().slice(0, 500);
}

function extractProblemDescription(speech: string): string | null {
  const lower = speech.toLowerCase();

  if (/tree (hit|fell|damaged)|hole in the roof|roof (is )?(leak|damaged|destroyed)/i.test(speech)) {
    return speech.trim().slice(0, 500);
  }

  if (/shingle|leak|damage|storm|hail|water|emergency|urgent/i.test(lower) && speech.length > 12) {
    return speech.trim().slice(0, 500);
  }

  return null;
}

function extractAdjusterContact(speech: string): boolean | null {
  const normalized = speech.toLowerCase();

  if (/\badjuster\b/.test(normalized)) {
    return parseExplicitBoolean(speech);
  }

  if (/\b(haven't talked to|have not talked to|haven't contacted|have not contacted)\b.*\badjuster\b/.test(
    normalized,
  )) {
    return false;
  }

  if (/\b(talked to|spoken to|contacted)\b.*\badjuster\b/.test(normalized)) {
    return true;
  }

  return null;
}

function extractInsuranceClaim(speech: string): boolean | null {
  const normalized = speech.toLowerCase();

  if (/\b(insurance|claim)\b/.test(normalized)) {
    return parseExplicitBoolean(speech) ?? parseCorrectionBoolean(speech);
  }

  if (/\bno claim\b|\bnot yet\b.*\bclaim\b|\bhaven't started\b.*\bclaim\b/.test(normalized)) {
    return false;
  }

  return null;
}

function extractPhotosAvailable(speech: string): boolean | null {
  if (/\b(photo|picture|image)s?\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }

  return null;
}

function extractActiveLeak(speech: string): boolean | null {
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

function applyExtractedBooleans(fields: RealtimeFields, speech: string): RealtimeFields {
  let updated = { ...fields };

  const insurance = extractInsuranceClaim(speech);
  if (insurance !== null) {
    updated.insurance_claim_started = insurance;
  }

  const adjuster = extractAdjusterContact(speech);
  if (adjuster !== null) {
    updated.adjuster_contacted = adjuster;
  }

  const photos = extractPhotosAvailable(speech);
  if (photos !== null) {
    updated.photos_available = photos;
  }

  const leak = extractActiveLeak(speech);
  if (leak !== null) {
    updated.emergency_or_active_leak = leak;
  }

  return updated;
}

export function extractAllFieldsFromTranscript(
  speech: string,
  callerPhone?: string,
): Partial<RealtimeFields> {
  const trimmed = speech.trim();

  if (!trimmed) {
    return {};
  }

  const libExtracted = extractFieldsFromSpeech(trimmed, callerPhone);
  const extracted: Partial<RealtimeFields> = {};

  if (hasValue(libExtracted.full_name)) {
    extracted.full_name = libExtracted.full_name;
  } else {
    const looseName = trimmed.match(
      /\b(?:i'?m|my name is|this is|name'?s)\s+([A-Za-z]+(?:\s+[A-Za-z'-]+)?)/i,
    )?.[1];
    if (looseName) {
      extracted.full_name = looseName.trim();
    }
  }

  if (hasValue(libExtracted.address)) {
    extracted.address = libExtracted.address;
  }

  if (hasValue(libExtracted.project_type)) {
    extracted.project_type = libExtracted.project_type;
  }

  if (hasValue(libExtracted.urgency)) {
    extracted.urgency = libExtracted.urgency;
  }

  if (hasValue(libExtracted.appointment_preference)) {
    extracted.appointment_preference = libExtracted.appointment_preference;
  }

  if (hasValue(libExtracted.storm_damage)) {
    extracted.storm_damage = libExtracted.storm_damage;
  }

  const problem = extractProblemDescription(trimmed) ?? libExtracted.problem_description;
  if (hasValue(problem)) {
    extracted.problem_description = problem;
  }

  const callbackPhone = extractCallbackPhoneFromSpeech(trimmed, callerPhone);
  if (callbackPhone) {
    extracted.callback_phone = callbackPhone;
    extracted.callback_phone_confirmed = false;
  }

  const withBooleans = applyExtractedBooleans(extracted as RealtimeFields, trimmed);

  if (detectEmergency(trimmed)) {
    withBooleans.urgency = withBooleans.urgency ?? "emergency";
    if (
      /water.*(inside|getting in|coming into)|active leak|leaking inside|flooding/i.test(trimmed)
    ) {
      withBooleans.emergency_or_active_leak = withBooleans.emergency_or_active_leak ?? true;
      withBooleans.emergency_acknowledged = withBooleans.emergency_acknowledged ?? true;
    }
  }

  return withBooleans;
}

export function mergeExtractedFields(
  fields: RealtimeFields,
  extracted: Partial<RealtimeFields>,
): RealtimeFields {
  let updated: RealtimeFields = { ...fields };

  updated.full_name = mergeStringField(updated.full_name, extracted.full_name);
  updated.address = mergeStringField(updated.address, extracted.address);
  updated.project_type = mergeStringField(updated.project_type, extracted.project_type);
  updated.urgency = mergeStringField(updated.urgency, extracted.urgency);
  updated.appointment_preference = mergeStringField(
    updated.appointment_preference,
    extracted.appointment_preference,
  );
  updated.storm_damage = mergeStringField(updated.storm_damage, extracted.storm_damage);
  updated.problem_description = mergeStringField(
    updated.problem_description,
    extracted.problem_description,
  );

  if (hasValue(extracted.callback_phone)) {
    const normalized = normalizeCallbackPhoneE164(extracted.callback_phone!);

    if (!isCompanyPhoneNumber(normalized)) {
      updated.callback_phone = normalized;
      updated.callback_phone_confirmed = false;
    }
  }

  if (extracted.insurance_claim_started !== undefined && extracted.insurance_claim_started !== null) {
    updated.insurance_claim_started = extracted.insurance_claim_started;
  }

  if (extracted.adjuster_contacted !== undefined && extracted.adjuster_contacted !== null) {
    updated.adjuster_contacted = extracted.adjuster_contacted;
  }

  if (extracted.photos_available !== undefined && extracted.photos_available !== null) {
    updated.photos_available = extracted.photos_available;
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

  return syncLegacyStringFields(updated);
}
