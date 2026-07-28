import {
  getFieldCompletionStatus,
  isFieldAskable,
  markFieldDerived,
  type FieldCompletionStatus,
} from "./field-completion.js";
import {
  inferFieldsFromCapturedContext,
  LEAK_SIGNAL_PATTERN,
  problemDescriptionImpliesActiveLeak,
} from "./field-normalization.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import {
  isScheduleComplete,
  processScheduleCapture,
} from "./schedule-normalizer.js";
import { isAddressConfirmed, hasConfirmableAddress } from "./address-confirmation.js";
import { hasCompleteCallerName } from "./caller-name-intake.js";
import {
  isStructuredBooleanUnset,
  syncLegacyStringFields,
} from "./structured-intake.js";
import type { RequiredFieldKey } from "./required-intake.js";

export type FieldKnowledgeSource = "known" | "derived" | "confirmed" | "missing";

export type ConversationReasoningSnapshot = {
  normalizedFields: RealtimeFields;
  knownFacts: RequiredFieldKey[];
  derivedFacts: RequiredFieldKey[];
  confirmedFacts: RequiredFieldKey[];
  missingFacts: RequiredFieldKey[];
  nextField: RequiredFieldKey | null;
  skipReasons: Partial<Record<RequiredFieldKey, string>>;
};

const INFERENCE_PRIORITY: RequiredFieldKey[] = [
  "emergency_or_active_leak",
  "callback_phone",
  "address",
  "problem_description",
  "urgency",
  "insurance_claim_started",
  "adjuster_contacted",
  "appointment_preference",
  "full_name",
];

const WEEKDAY_PATTERN =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function collectInferenceText(fields: RealtimeFields, recentSpeech?: string): string {
  return [
    fields.problem_description,
    fields.additional_notes,
    fields.appointment_preference_raw,
    fields.appointment_preference,
    fields.urgency,
    recentSpeech,
  ]
    .filter((part) => hasValue(part))
    .join(" ");
}

function isCallbackComplete(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed === true;
}

function inferUrgencyFromText(text: string): string | null {
  const lower = text.toLowerCase();

  if (
    /\b(another|next|more)\s+storm\s+(is\s+)?(coming|expected|forecast|hitting|on the way)\b/i.test(
      lower,
    ) ||
    /\bstorm\s+(is\s+)?(coming|expected|forecast|hitting)\s+(tomorrow|tonight|today)\b/i.test(
      lower,
    ) ||
    /\bstorm\s+tomorrow\b/i.test(lower)
  ) {
    return "high";
  }

  if (/\b(asap|as soon as possible|right away|immediately|need someone out today)\b/i.test(lower)) {
    return "urgent";
  }

  if (/\bleaving town\b/i.test(lower) && WEEKDAY_PATTERN.test(lower)) {
    return "high";
  }

  if (/\badjuster\s+(is\s+)?(coming|scheduled|visiting)\b/i.test(lower)) {
    return "high";
  }

  return null;
}

function inferScheduleHintFromText(text: string): string | null {
  const lower = text.toLowerCase();

  if (
    /\b(another|next|more)\s+storm\s+(is\s+)?(coming|expected|forecast|hitting|on the way)\b/i.test(
      lower,
    ) ||
    /\bstorm\s+(is\s+)?(coming|expected|forecast|hitting)\s+(tomorrow|tonight|today)\b/i.test(
      lower,
    ) ||
    /\bstorm\s+tomorrow\b/i.test(lower)
  ) {
    return "as soon as possible";
  }

  const afterWorkMatch = lower.match(
    /\b(?:call me\s+)?(?:after work|when i get off|after i get off)(?:\s+(?:around|about|at))?\s+(?:five|5|four|4|six|6|seven|7|eight|8|nine|9|ten|10|eleven|11|twelve|12)\b/i,
  );
  if (afterWorkMatch) {
    return afterWorkMatch[0].trim();
  }

  if (/\bafter work\b/i.test(lower)) {
    return "after work";
  }

  const leavingTownMatch = lower.match(
    /\bleaving town\b[^.!?]{0,40}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i,
  );
  if (leavingTownMatch) {
    return `before ${leavingTownMatch[1]}`;
  }

  const adjusterMatch = lower.match(
    /\badjuster\s+(?:is\s+)?(?:coming|scheduled|visiting|due)\s+(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i,
  );
  if (adjusterMatch) {
    return `before ${adjusterMatch[1]}`;
  }

  const insuranceAdjusterMatch = lower.match(
    /\b(?:insurance )?adjuster\b[^.!?]{0,40}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i,
  );
  if (insuranceAdjusterMatch) {
    return `before ${insuranceAdjusterMatch[1]}`;
  }

  return null;
}

function applyInferredSchedule(fields: RealtimeFields, hint: string): RealtimeFields {
  if (isScheduleComplete(fields)) {
    return fields;
  }

  let updated: RealtimeFields = syncLegacyStringFields({
    ...fields,
    appointment_preference_raw: hint,
    schedule_confirmed: false,
  });

  updated = processScheduleCapture(updated, hint).fields;

  if (isScheduleComplete(updated)) {
    return markFieldDerived(updated, "appointment_preference");
  }

  if (hasValue(updated.appointment_preference_raw)) {
    return markFieldDerived(updated, "appointment_preference");
  }

  return updated;
}

/** Apply contextual inference from everything the caller has already said. */
export function applyConversationInferences(
  fields: RealtimeFields,
  recentSpeech?: string,
): RealtimeFields {
  let updated = inferFieldsFromCapturedContext(fields);
  const text = collectInferenceText(updated, recentSpeech);

  const inferredUrgency = inferUrgencyFromText(text);
  if (inferredUrgency) {
    if (!hasValue(updated.urgency)) {
      updated = syncLegacyStringFields({
        ...updated,
        urgency: inferredUrgency,
      });
    }
    updated = markFieldDerived(updated, "urgency");
  }

  if (!isScheduleComplete(updated)) {
    const scheduleHint =
      inferScheduleHintFromText(text) ??
      (hasValue(updated.appointment_preference_raw) ? null : null);

    if (scheduleHint && !hasValue(updated.appointment_preference_raw)) {
      updated = applyInferredSchedule(updated, scheduleHint);
    } else if (
      hasValue(updated.appointment_preference_raw) &&
      updated.field_resolution?.appointment_preference !== "derived" &&
      updated.field_resolution?.appointment_preference !== "confirmed"
    ) {
      updated = applyInferredSchedule(updated, updated.appointment_preference_raw!);
    }
  }

  return updated;
}

function classifyFieldSource(
  field: RequiredFieldKey,
  fields: RealtimeFields,
): FieldKnowledgeSource {
  const status = getFieldCompletionStatus(field, fields);

  if (status === "confirmed") {
    return "confirmed";
  }

  if (fields.field_resolution?.[field] === "derived") {
    return "derived";
  }

  if (status === "captured" || status === "uncertain") {
    return status === "uncertain" ? "confirmed" : "known";
  }

  switch (field) {
    case "emergency_or_active_leak":
      if (!isStructuredBooleanUnset(fields.emergency_or_active_leak)) {
        return fields.field_resolution?.[field] === "derived" ? "derived" : "known";
      }
      if (problemDescriptionImpliesActiveLeak(fields.problem_description)) {
        return "derived";
      }
      break;
    case "urgency":
      if (hasValue(fields.urgency)) {
        return fields.field_resolution?.[field] === "derived" ? "derived" : "known";
      }
      break;
    case "appointment_preference":
      if (isScheduleComplete(fields)) {
        return fields.schedule_confirmed ? "confirmed" : "known";
      }
      if (hasValue(fields.appointment_preference_raw) || hasValue(fields.appointment_preference)) {
        return fields.field_resolution?.[field] === "derived" ? "derived" : "known";
      }
      break;
    case "callback_phone":
      if (isCallbackComplete(fields)) {
        return "confirmed";
      }
      if (hasValue(fields.callback_phone)) {
        return "known";
      }
      break;
    case "address":
      if (isAddressConfirmed(fields)) {
        return "confirmed";
      }
      if (hasConfirmableAddress(fields.address)) {
        return "known";
      }
      break;
    case "full_name":
      if (fields.caller_name_declined || fields.caller_name_unavailable) {
        return "confirmed";
      }
      if (hasCompleteCallerName(fields)) {
        return "known";
      }
      break;
    case "problem_description":
      if (hasValue(fields.problem_description)) {
        return "known";
      }
      break;
    case "insurance_claim_started":
    case "adjuster_contacted":
      if (!isStructuredBooleanUnset(fields[field])) {
        return "known";
      }
      break;
    default:
      break;
  }

  return "missing";
}

function isFieldKnownEnoughToSkip(field: RequiredFieldKey, fields: RealtimeFields): boolean {
  const source = classifyFieldSource(field, fields);

  if (source === "confirmed" || source === "derived" || source === "known") {
    return !isFieldAskable(field, fields);
  }

  return false;
}

function buildSkipReason(field: RequiredFieldKey, fields: RealtimeFields): string | undefined {
  const source = classifyFieldSource(field, fields);

  if (source === "confirmed") {
    return "already confirmed";
  }

  if (source === "derived") {
    switch (field) {
      case "urgency":
        return "urgency inferred from caller context";
      case "appointment_preference":
        return "timing inferred from caller context";
      case "emergency_or_active_leak":
        return "active leak inferred from damage description";
      default:
        return "inferred from caller context";
    }
  }

  if (source === "known" && !isFieldAskable(field, fields)) {
    return "already captured";
  }

  if (field === "appointment_preference" && hasValue(fields.appointment_preference_raw)) {
    return "callback timing already mentioned";
  }

  if (field === "urgency" && hasValue(fields.urgency)) {
    return "urgency already captured";
  }

  return undefined;
}

function needsImmediateSafetyClarification(fields: RealtimeFields): boolean {
  if (!isStructuredBooleanUnset(fields.emergency_or_active_leak)) {
    return false;
  }

  if (fields.emergency_acknowledged === true) {
    return true;
  }

  const problem = fields.problem_description?.toLowerCase() ?? "";

  return (
    problemDescriptionImpliesActiveLeak(problem) ||
    LEAK_SIGNAL_PATTERN.test(problem) ||
    /\b(active leak|water (is )?((getting )?in|inside|pouring|leaking)|pouring in|flooding|emergency|collapse|structural damage|someone (is )?hurt|injured)\b/i.test(
      problem,
    )
  );
}

function collectMissingFieldsAfterReasoning(fields: RealtimeFields): RequiredFieldKey[] {
  const missing: RequiredFieldKey[] = [];

  if (needsImmediateSafetyClarification(fields)) {
    missing.push("emergency_or_active_leak");
  }

  if (!hasCompleteCallerName(fields) && !fields.caller_name_declined && !fields.caller_name_unavailable) {
    missing.push("full_name");
  }

  if (!hasValue(fields.problem_description)) {
    missing.push("problem_description");
  }

  if (!isCallbackComplete(fields) && !hasValue(fields.callback_phone)) {
    missing.push("callback_phone");
  }

  if (!isAddressConfirmed(fields) && !hasConfirmableAddress(fields.address)) {
    missing.push("address");
  }

  if (
    !isFieldKnownEnoughToSkip("emergency_or_active_leak", fields) &&
    isStructuredBooleanUnset(fields.emergency_or_active_leak) &&
    !missing.includes("emergency_or_active_leak")
  ) {
    missing.push("emergency_or_active_leak");
  }

  if (!isFieldKnownEnoughToSkip("urgency", fields) && !hasValue(fields.urgency)) {
    missing.push("urgency");
  }

  if (
    !isFieldKnownEnoughToSkip("insurance_claim_started", fields) &&
    isStructuredBooleanUnset(fields.insurance_claim_started) &&
    !fields.insurance_status
  ) {
    missing.push("insurance_claim_started");
  }

  if (
    fields.insurance_claim_started === true &&
    !isFieldKnownEnoughToSkip("adjuster_contacted", fields) &&
    isStructuredBooleanUnset(fields.adjuster_contacted)
  ) {
    missing.push("adjuster_contacted");
  }

  if (
    !isFieldKnownEnoughToSkip("appointment_preference", fields) &&
    !isScheduleComplete(fields) &&
    !hasValue(fields.appointment_preference_raw)
  ) {
    missing.push("appointment_preference");
  }

  return missing.filter((field) => isFieldAskable(field, fields));
}

/** Reasoning step executed before every next-question selection. */
export function buildConversationReasoning(fields: RealtimeFields): ConversationReasoningSnapshot {
  const normalizedFields = applyConversationInferences(fields);
  const skipReasons: Partial<Record<RequiredFieldKey, string>> = {};

  const knownFacts: RequiredFieldKey[] = [];
  const derivedFacts: RequiredFieldKey[] = [];
  const confirmedFacts: RequiredFieldKey[] = [];
  const missingFacts: RequiredFieldKey[] = [];

  for (const field of INFERENCE_PRIORITY) {
    const source = classifyFieldSource(field, normalizedFields);
    const skipReason = buildSkipReason(field, normalizedFields);

    if (skipReason) {
      skipReasons[field] = skipReason;
    }

    switch (source) {
      case "known":
        knownFacts.push(field);
        break;
      case "derived":
        derivedFacts.push(field);
        break;
      case "confirmed":
        confirmedFacts.push(field);
        break;
      case "missing":
        missingFacts.push(field);
        break;
      default:
        break;
    }
  }

  const prioritizedMissing = collectMissingFieldsAfterReasoning(normalizedFields);
  const nextField = prioritizedMissing[0] ?? null;

  return {
    normalizedFields,
    knownFacts,
    derivedFacts,
    confirmedFacts,
    missingFacts,
    nextField,
    skipReasons,
  };
}

export function selectNextFieldWithReasoning(fields: RealtimeFields): RequiredFieldKey | null {
  return buildConversationReasoning(fields).nextField;
}

export function buildUrgencyAcknowledgment(fields: RealtimeFields): string | null {
  if (fields.field_resolution?.urgency !== "derived" && !/\b(high|urgent|emergency)\b/i.test(fields.urgency ?? "")) {
    return null;
  }

  if (/\b(asap|as soon as possible|right away|immediately)\b/i.test(collectInferenceText(fields))) {
    return "I'll note that you'd like someone contacted as soon as possible.";
  }

  if (/\bstorm\b/i.test(collectInferenceText(fields))) {
    return "I'll mark this as urgent with the storm coming.";
  }

  return "I'll mark this as urgent.";
}

export function buildTimingAcknowledgment(fields: RealtimeFields): string | null {
  const timing =
    fields.appointment_preference?.trim() ||
    fields.appointment_preference_raw?.trim();

  if (!timing) {
    return null;
  }

  if (/\bafter work\b/i.test(timing)) {
    return "I'll note you'd like a callback after work.";
  }

  if (/\bbefore\b/i.test(timing)) {
    return `I'll note you'd prefer someone out ${timing}.`;
  }

  if (/\bas soon as possible\b/i.test(timing)) {
    return "I'll note you'd like someone contacted as soon as possible.";
  }

  return null;
}

export function buildReasoningAwareTransition(
  field: RequiredFieldKey,
  fields: RealtimeFields,
  baseQuestion: string,
): string {
  if (field === "urgency") {
    const ack = buildUrgencyAcknowledgment(fields);
    if (ack) {
      return ack;
    }
  }

  if (field === "appointment_preference") {
    const timingAck = buildTimingAcknowledgment(fields);
    if (timingAck && hasValue(fields.appointment_preference_raw)) {
      return timingAck;
    }
  }

  return baseQuestion;
}
