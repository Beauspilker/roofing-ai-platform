import { detectEmergency, hasCorrectionIntent } from "../../../../lib/call-intelligence.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import {
  appendContextNote,
  markFieldCaptured,
  markFieldUncertain,
} from "./field-completion.js";
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
  sanitizeAddressValue,
} from "./address-confirmation.js";
import {
  extractDamageOrCallReason,
  extractExplicitCallerName,
  isCallerNameDeclinedSpeech,
  isCallerNameUnavailableSpeech,
  isLikelyCallReasonSpeech,
  isPlausibleCallerName,
  isPlausibleServiceAddress,
  validateCallerNameCandidate,
} from "./field-validation.js";
import {
  isPendingCallReasonQuestion,
  isShortYesNoReasonAnswer,
  normalizeCallReasonFromSpeech,
} from "./call-reason-handling.js";
import { isCallerNameResolved } from "./required-intake.js";
import { hasCompleteCallerName, processCallerNameTurn, syncFullNameFromParts } from "./caller-name-intake.js";
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
  const longAnswer = parseInsuranceLongAnswer(speech);
  if (longAnswer?.resolved && longAnswer.insurance_claim_started !== undefined && longAnswer.insurance_claim_started !== null) {
    return longAnswer.insurance_claim_started;
  }

  if (allowsBooleanDirectAnswer(pending, "insurance_claim")) {
    const parsed = parseInsuranceLongAnswer(speech);
    if (parsed?.resolved) {
      return parsed.insurance_claim_started ?? null;
    }
    return parseExplicitBoolean(speech);
  }

  if (/\b(insurance|claim|adjuster|out of pocket|estimate)\b/i.test(speech)) {
    const parsed = parseInsuranceLongAnswer(speech);
    if (parsed?.resolved && parsed.insurance_claim_started !== undefined && parsed.insurance_claim_started !== null) {
      return parsed.insurance_claim_started;
    }
    if (speech.trim().split(/\s+/).length <= 8) {
      return parseExplicitBoolean(speech);
    }
  }

  return null;
}

function extractAdjusterContact(speech: string, pending: PendingQuestionKey | null): boolean | null {
  const longAnswer = parseInsuranceLongAnswer(speech);
  if (longAnswer?.resolved && longAnswer.adjuster_contacted !== undefined && longAnswer.adjuster_contacted !== null) {
    return longAnswer.adjuster_contacted;
  }

  if (/\b(insurance|adjuster|inspection)\b.*\b(haven't|hasn't|have not|has not|not yet|no one|nobody)\b.*\b(come out|been out|visited|shown up|contacted|called)\b/i.test(
    speech,
  )) {
    return false;
  }

  if (/\b(haven't|hasn't|have not|has not|not yet)\b.*\b(adjuster|insurance)\b.*\b(come out|been out|visited|contacted|called)\b/i.test(
    speech,
  )) {
    return false;
  }

  if (allowsBooleanDirectAnswer(pending, "adjuster_contacted")) {
    return parseExplicitBoolean(speech);
  }

  if (/\badjuster\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }

  return null;
}

export type InsuranceLongAnswerResult = {
  insurance_claim_started?: boolean | null;
  adjuster_contacted?: boolean | null;
  uncertainClaim?: boolean;
  insuranceStatus?: string;
  contextNote?: string;
  resolved?: boolean;
};

export function parseInsuranceLongAnswer(speech: string): InsuranceLongAnswerResult | null {
  const trimmed = speech.trim();
  const lower = trimmed.toLowerCase();

  if (
    !trimmed ||
    (!/\b(insurance|claim|adjuster|estimate|out of pocket|came out|approved|paying)\b/i.test(
      trimmed,
    ) &&
      !/^(i'm not sure yet|not sure yet|unsure|i don't know yet)\.?$/i.test(lower))
  ) {
    return null;
  }

  const result: InsuranceLongAnswerResult = {
    contextNote: trimmed.length > 12 ? trimmed : undefined,
  };

  if (/^(i'm not sure yet|not sure yet|unsure|i don't know yet)\.?$/i.test(lower)) {
    result.uncertainClaim = true;
    result.resolved = true;
    return result;
  }

  if (
    /\b(paying out of pocket|pay out of pocket|paying cash|out of pocket|self[- ]?pay|no insurance)\b/i.test(
      trimmed,
    )
  ) {
    result.insurance_claim_started = false;
    result.insuranceStatus = "out_of_pocket";
    result.resolved = true;
  }

  if (
    /\b(just want an estimate|estimate first|want an estimate|not filing|no claim|not a claim)\b/i.test(
      trimmed,
    )
  ) {
    result.insurance_claim_started = false;
    result.insuranceStatus = "estimate_only";
    result.resolved = true;
  }

  if (
    /\b(haven't|have not|didn't|did not|hasn't|has not)\s+(been\s+)?(called|contacted|reached|spoken to|filed with)\b/i.test(
      trimmed,
    ) &&
    /\b(insurance|claim|adjuster|them)\b/i.test(trimmed)
  ) {
    result.insurance_claim_started = false;
    result.resolved = true;
  }

  if (
    /\b(haven't|have not|didn't|did not)\s+(called|contacted|reached|spoken to|filed with)\s+(the\s+)?(insurance|my insurance|insurance company|them|a claim)\b/i.test(
      trimmed,
    ) ||
    /\b(haven't|have not|didn't|did not)\s+(contacted|called|spoken to|reached|filed with)\s+(the\s+)?(insurance|my insurance|insurance company|a claim)/i.test(
      trimmed,
    ) ||
    /\bno claim yet\b/i.test(lower)
  ) {
    result.insurance_claim_started = false;
    result.resolved = true;
  }

  if (/\binsurance is involved\b/i.test(trimmed)) {
    result.insurance_claim_started = result.insurance_claim_started ?? true;
    result.uncertainClaim = result.uncertainClaim ?? true;
    result.resolved = true;
  }

  if (
    /\b(might be|could be|think it is|maybe)\b.*\b(insurance claim|an insurance claim|a claim)\b/i.test(
      trimmed,
    ) &&
    /\b(haven't|have not|didn't|did not)\s+(contacted|called|reached)\b/i.test(trimmed)
  ) {
    result.uncertainClaim = true;
    result.insurance_claim_started = result.insurance_claim_started ?? false;
    result.resolved = true;
  }

  if (
    /\b(wasn't sure|was not sure|not sure|unsure|don't know|do not know)\b.*\b(claim|insurance|damage|bad enough|warrant|estimate)\b/i.test(
      trimmed,
    )
  ) {
    result.uncertainClaim = true;
    result.resolved = true;
  }

  if (
    /\b(came out|been out|visited|was here|inspection)\b.*\b(yesterday|today|last week|adjuster|insurance)\b/i.test(
      trimmed,
    ) ||
    /\b(adjuster|insurance)\b.*\b(came out|been out|visited|was here|inspection)\b/i.test(trimmed) ||
    /\b(insurance|adjuster)\s+came out\b/i.test(trimmed)
  ) {
    result.adjuster_contacted = true;
    result.insurance_claim_started = result.insurance_claim_started ?? true;
    if (
      /\b(nothing has been approved|not approved|not been approved|pending|unresolved|no decision|waiting on)\b/i.test(
        trimmed,
      )
    ) {
      result.insuranceStatus = "adjuster_visited_unresolved";
      result.uncertainClaim = true;
    }
    result.resolved = true;
  }

  if (
    /\b(no adjuster|adjuster hasn't|adjuster has not|no one has come|nobody has come)\b/i.test(trimmed) ||
    /\b(insurance|adjuster)\b.*\b(haven't|hasn't|have not|has not|not yet|no one)\b.*\b(come out|been out|visited|shown up|contacted)\b/i.test(
      trimmed,
    ) ||
    /\b(haven't|hasn't|have not|has not|not yet)\b.*\b(adjuster|insurance)\b.*\b(come out|been out|visited|contacted)\b/i.test(
      trimmed,
    )
  ) {
    result.adjuster_contacted = false;
    result.resolved = true;
  }

  if (trimmed.split(/\s+/).length <= 6) {
    const explicit = parseExplicitBoolean(trimmed);
    if (explicit !== null && /\b(insurance|claim|adjuster)\b/i.test(trimmed)) {
      if (/\badjuster\b/i.test(trimmed)) {
        result.adjuster_contacted = explicit;
      } else {
        result.insurance_claim_started = explicit;
      }
      result.resolved = true;
    }
  }

  if (
    result.insurance_claim_started === undefined &&
    result.adjuster_contacted === undefined &&
    !result.uncertainClaim &&
    !result.insuranceStatus
  ) {
    return null;
  }

  result.resolved = result.resolved ?? true;
  return result;
}

export function applyInsuranceLongAnswerToFields(
  fields: RealtimeFields,
  speech: string,
): RealtimeFields {
  const parsed = parseInsuranceLongAnswer(speech);
  if (!parsed) {
    return fields;
  }

  let updated: RealtimeFields = { ...fields };

  if (parsed.insurance_claim_started !== undefined && parsed.insurance_claim_started !== null) {
    updated.insurance_claim_started = parsed.insurance_claim_started;
  }

  if (parsed.adjuster_contacted !== undefined && parsed.adjuster_contacted !== null) {
    updated.adjuster_contacted = parsed.adjuster_contacted;
  }

  if (parsed.insuranceStatus) {
    updated.insurance_status = parsed.insuranceStatus.slice(0, 120);
  }

  if (parsed.contextNote) {
    updated = appendContextNote(updated, parsed.contextNote);
  }

  if (parsed.uncertainClaim) {
    updated = markFieldUncertain(
      updated,
      "insurance_claim_started",
      parsed.contextNote ?? speech.trim(),
    );
  } else if (parsed.resolved) {
    updated = markFieldCaptured(updated, "insurance_claim_started");
  }

  if (parsed.adjuster_contacted !== undefined && parsed.adjuster_contacted !== null) {
    updated = markFieldCaptured(updated, "adjuster_contacted");
  } else if (parsed.resolved && updated.insurance_claim_started === false) {
    updated = markFieldCaptured(updated, "adjuster_contacted");
  }

  return syncLegacyStringFields(updated);
}

function extractActiveLeak(speech: string, pending: PendingQuestionKey | null): boolean | null {
  if (allowsBooleanDirectAnswer(pending, "active_leak")) {
    return parseExplicitBoolean(speech);
  }

  const leakSignal =
    /\b(leak|water|drip|flooding|getting inside|active leak|leaking|intrusion|moisture|dripping)\b/i;

  if (leakSignal.test(speech)) {
    if (
      /\b(no|not|none)\s+(active\s+)?(leak|water)\b|\b(no leak|not leaking|no water damage)\b/i.test(
        speech,
      )
    ) {
      return false;
    }

    if (
      /water.*(inside|getting in|coming into|leaking into|pouring)|active leak|leaking inside|pouring into|coming into the|leaking into|ceiling is dripping|water intrusion|moisture is coming in|leaks when it rains|roof leak|there is a leak|there'?s a leak/i.test(
        speech,
      )
    ) {
      return true;
    }

    if (/\b(is leaking|water is leaking|water'?s leaking)\b/i.test(speech)) {
      return true;
    }

    if (speech.trim().split(/\s+/).length <= 8) {
      const parsed = parseExplicitBoolean(speech);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

export function extractAddressFromSpeech(speech: string): string | null {
  const correctionMatch = speech.match(
    /(?:no,?|actually|instead|rather|correction).*?(?:address is|it's|it is)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i,
  );
  if (correctionMatch?.[1] && isPlausibleServiceAddress(correctionMatch[1])) {
    return correctionMatch[1].trim();
  }

  const addressIsMatch = speech.match(
    /\b(?:the )?address is\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i,
  );
  if (addressIsMatch?.[1] && isPlausibleServiceAddress(addressIsMatch[1])) {
    return addressIsMatch[1].trim();
  }

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

function extractScheduleHint(speech: string): string | null {
  const patterns = [
    /\b(?:i'?m |i am )?(?:available|free|good)\s+(?:after|from|around|at)\s+[^,.;]+/i,
    /\b(?:available|free)\s+(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?/i,
    /\b(?:anytime|whenever)\s+(?:after|before|around)\s+[^,.;]+/i,
    /\b(?:after|before)\s+(?:work|five|5|noon|morning|afternoon|evening)\b[^,.;]*/i,
    /\b(?:morning|afternoon|evening)\s+(?:works|would work|is fine|is good)\b/i,
  ];

  for (const pattern of patterns) {
    const match = speech.match(pattern);
    if (match?.[0]) {
      return match[0].trim().slice(0, 200);
    }
  }

  return null;
}

function extractDamageCause(speech: string): Partial<RealtimeFields> {
  const lower = speech.toLowerCase();
  const extracted: Partial<RealtimeFields> = {};

  if (/\bhail\b/i.test(lower)) {
    extracted.project_type = "storm damage";
    extracted.storm_damage = "yes";
  } else if (/\bwind damage|\bwind\b/i.test(lower)) {
    extracted.project_type = "wind damage";
    extracted.storm_damage = "yes";
  } else if (/\b(storm|tornado|hurricane)\b/i.test(lower)) {
    extracted.project_type = "storm damage";
    extracted.storm_damage = "yes";
  }

  return extracted;
}

function extractPhotosAvailable(speech: string): boolean | null {
  if (!/\b(photo|picture|image|video)s?\b/i.test(speech)) {
    return null;
  }

  const normalized = speech.trim().toLowerCase();

  if (/\b(no|don't|do not|haven't|have not)\b.*\b(photo|picture|image)s?\b/i.test(normalized)) {
    return false;
  }

  if (
    /\b(i have (some )?(photos|pictures|images)|i've got (some )?(photos|pictures|images)|got (some )?(photos|pictures|images))\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/\b(photo|picture|image)s?\b.*\b(on my phone|on my cell|ready|available)\b/i.test(normalized)) {
    return true;
  }

  if (normalized.split(/\s+/).length <= 6) {
    return parseExplicitBoolean(speech);
  }

  return null;
}

export function applyAdaptiveCorrections(
  fields: RealtimeFields,
  speech: string,
): RealtimeFields {
  if (!hasCorrectionIntent(speech)) {
    return fields;
  }

  let updated: RealtimeFields = { ...fields };
  const address = extractAddressFromSpeech(speech);

  if (address) {
    updated.address = sanitizeAddressValue(address).slice(0, 500);
    updated.address_confirmed = false;
  }

  const explicitName = extractExplicitCallerName(speech);
  if (explicitName && isPlausibleCallerName(explicitName)) {
    updated.full_name = explicitName.slice(0, 100);
    updated.name_pending_confirmation = undefined;
  }

  const callbackPhone = extractCallbackPhoneFromSpeech(speech);
  if (callbackPhone && !isCompanyPhoneNumber(normalizeCallbackPhoneE164(callbackPhone))) {
    updated.callback_phone = normalizeCallbackPhoneE164(callbackPhone);
    updated.callback_phone_confirmed = false;
  }

  return preserveConfirmedFieldState(fields, syncLegacyStringFields(updated));
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

  if (isPendingCallReasonQuestion(pendingQuestion)) {
    const reason = normalizeCallReasonFromSpeech(trimmed);
    if (reason) {
      extracted.problem_description = reason;
    }
  }

  Object.assign(extracted, extractDamageCause(trimmed));

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

  const insuranceLong = parseInsuranceLongAnswer(trimmed);
  if (insuranceLong?.contextNote) {
    extracted.additional_notes = insuranceLong.contextNote.slice(0, 500);
  }
  if (insuranceLong?.insuranceStatus) {
    extracted.insurance_status = insuranceLong.insuranceStatus.slice(0, 120);
  }

  const insurance = extractInsuranceClaim(trimmed, pendingQuestion);
  if (insurance !== null) {
    extracted.insurance_claim_started = insurance;
  }

  const adjuster = extractAdjusterContact(trimmed, pendingQuestion);
  if (adjuster !== null) {
    extracted.adjuster_contacted = adjuster;
  }

  const scheduleHint = extractScheduleHint(trimmed);
  if (scheduleHint) {
    extracted.appointment_preference_raw = scheduleHint;
  }

  const photos = extractPhotosAvailable(trimmed);
  if (photos !== null) {
    extracted.photos_available = photos;
  }

  const leak = extractActiveLeak(trimmed, pendingQuestion);
  if (leak !== null) {
    extracted.emergency_or_active_leak = leak;
  }

  if (detectEmergency(trimmed)) {
    extracted.urgency = extracted.urgency ?? "emergency";
    if (
      /water.*(inside|getting in|coming into|leaking into)|active leak|leaking inside|flooding|pouring into|leaking into|ceiling is dripping|water intrusion|moisture is coming in|leaks when it rains|roof leak|there is a leak|there'?s a leak|\b(is leaking|water is leaking|water'?s leaking)\b/i.test(
        trimmed,
      )
    ) {
      extracted.emergency_or_active_leak = extracted.emergency_or_active_leak ?? true;
      extracted.emergency_acknowledged = true;
    }
  } else if (/\burgent\b/i.test(trimmed) && !hasValue(extracted.urgency)) {
    extracted.urgency = "urgent";
  }

  return extracted;
}

export function mergeExtractedFields(
  fields: RealtimeFields,
  extracted: Partial<RealtimeFields>,
  speech = "",
): RealtimeFields {
  let updated: RealtimeFields = { ...fields };
  const allowOverwrite = hasCorrectionIntent(speech);
  const insuranceLong = speech ? parseInsuranceLongAnswer(speech) : null;

  if (
    hasValue(extracted.full_name) &&
    isPlausibleCallerName(extracted.full_name!) &&
    (!hasValue(updated.full_name) || allowOverwrite)
  ) {
    updated.full_name = extracted.full_name!.trim().slice(0, 100);
  }

  if (
    hasValue(extracted.problem_description) &&
    (!hasValue(updated.problem_description) || allowOverwrite)
  ) {
    updated.problem_description = extracted.problem_description!.trim().slice(0, 500);
  }

  if (
    hasValue(extracted.address) &&
    isPlausibleServiceAddress(extracted.address!) &&
    (!hasValue(updated.address) || allowOverwrite)
  ) {
    updated.address = sanitizeAddressValue(extracted.address!.trim()).slice(0, 500);
    updated.address_confirmed = false;
  }

  if (hasValue(extracted.project_type) && (!hasValue(updated.project_type) || allowOverwrite)) {
    updated.project_type = extracted.project_type;
  }

  if (hasValue(extracted.storm_damage) && (!hasValue(updated.storm_damage) || allowOverwrite)) {
    updated.storm_damage = extracted.storm_damage;
  }

  if (hasValue(extracted.appointment_preference_raw) && !hasValue(updated.appointment_preference_raw)) {
    updated.appointment_preference_raw = extracted.appointment_preference_raw!.trim().slice(0, 200);
    updated.schedule_confirmed = false;
  }

  if (hasValue(extracted.additional_notes)) {
    updated = appendContextNote(updated, extracted.additional_notes!);
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
    if (insuranceLong?.uncertainClaim) {
      updated = markFieldUncertain(updated, "insurance_claim_started", insuranceLong.contextNote);
    } else if (insuranceLong?.resolved || updated.field_resolution?.insurance_claim_started !== "uncertain") {
      updated = markFieldCaptured(updated, "insurance_claim_started");
    }
  } else if (insuranceLong?.uncertainClaim || insuranceLong?.resolved) {
    updated = applyInsuranceLongAnswerToFields(updated, speech);
  }

  if (hasValue(extracted.insurance_status)) {
    updated.insurance_status = extracted.insurance_status;
  }

  if (extracted.adjuster_contacted !== undefined && extracted.adjuster_contacted !== null) {
    updated.adjuster_contacted = extracted.adjuster_contacted;
    updated = markFieldCaptured(updated, "adjuster_contacted");
  } else if (insuranceLong?.adjuster_contacted !== undefined && insuranceLong.adjuster_contacted !== null) {
    updated.adjuster_contacted = insuranceLong.adjuster_contacted;
    updated = markFieldCaptured(updated, "adjuster_contacted");
  }

  if (
    extracted.emergency_or_active_leak !== undefined &&
    extracted.emergency_or_active_leak !== null
  ) {
    updated.emergency_or_active_leak = extracted.emergency_or_active_leak;
    updated = markFieldCaptured(updated, "emergency_or_active_leak");
  }

  if (extracted.photos_available !== undefined && extracted.photos_available !== null) {
    updated.photos_available = extracted.photos_available;
  }

  if (hasValue(extracted.urgency) && !hasValue(updated.urgency)) {
    updated.urgency = extracted.urgency!.trim().slice(0, 200);
  }

  if (extracted.emergency_acknowledged) {
    updated.emergency_acknowledged = true;
  }

  if (hasValue(updated.full_name)) {
    updated = syncFullNameFromParts(updated);
    if (hasCompleteCallerName(updated)) {
      updated.opening_name_complete = true;
    }
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

      if (isLikelyCallReasonSpeech(trimmed) && !extractExplicitCallerName(trimmed)) {
        const reason = normalizeCallReasonFromSpeech(trimmed);
        if (reason && !hasValue(updated.problem_description)) {
          updated.problem_description = reason;
        }
        break;
      }

      if (!isCallerNameResolved(updated)) {
        updated = processCallerNameTurn(updated, trimmed).fields;
      }
      break;
    }
    case "reason_for_call":
    case "call_reason":
      if (!hasValue(updated.problem_description)) {
        if (isShortYesNoReasonAnswer(trimmed)) {
          updated.call_reason_awaiting_clarification = true;
          updated.call_reason_clarification_attempts =
            (updated.call_reason_clarification_attempts ?? 0) + 1;
          break;
        }

        const reason = normalizeCallReasonFromSpeech(trimmed);
        if (reason) {
          updated.problem_description = reason;
          updated.call_reason_awaiting_clarification = false;
          updated.name_pending_confirmation = undefined;
          updated.name_awaiting_repeat = undefined;

          const volunteeredName = extractExplicitCallerName(trimmed);
          if (volunteeredName && !hasValue(updated.full_name)) {
            updated.full_name = volunteeredName;
          }
        } else if (trimmed.length > 0) {
          updated.call_reason_awaiting_clarification = true;
          updated.call_reason_clarification_attempts =
            (updated.call_reason_clarification_attempts ?? 0) + 1;
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
          updated.address = sanitizeAddressValue(trimmed).slice(0, 500);
          updated.address_confirmed = false;
        }
      }
      break;
    case "insurance_claim":
    case "adjuster_contacted":
    case "active_leak": {
      if (pendingQuestion === "insurance_claim" || pendingQuestion === "adjuster_contacted") {
        const beforeResolution = updated.field_resolution?.insurance_claim_started;
        updated = applyInsuranceLongAnswerToFields(updated, trimmed);
        if (
          updated.field_resolution?.insurance_claim_started !== beforeResolution ||
          updated.insurance_status ||
          updated.field_resolution?.adjuster_contacted
        ) {
          break;
        }
      }

      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null && pendingQuestion !== "insurance_claim" && pendingQuestion !== "adjuster_contacted") {
        const fieldMap = {
          insurance_claim: "insurance_claim_started",
          adjuster_contacted: "adjuster_contacted",
          active_leak: "emergency_or_active_leak",
        } as const;
        updated[fieldMap[pendingQuestion]] = parsed;
      } else if (parsed !== null && trimmed.split(/\s+/).length <= 6) {
        const fieldMap = {
          insurance_claim: "insurance_claim_started",
          adjuster_contacted: "adjuster_contacted",
          active_leak: "emergency_or_active_leak",
        } as const;
        updated[fieldMap[pendingQuestion]] = parsed;
        updated = markFieldCaptured(updated, fieldMap[pendingQuestion]);
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
