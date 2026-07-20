import type { CollectedFields } from "../../../../lib/call-intake.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import type { AcknowledgmentPolicy } from "./acknowledgment-policy.js";
import {
  guardIntakeReply,
  joinAcknowledgmentAndQuestion,
} from "./acknowledgment-policy.js";
import {
  buildAddressReadbackConfirmation,
  needsAddressReadback,
} from "./address-confirmation.js";
import {
  buildCallbackReadbackConfirmation,
  extractCallbackPhoneFromSpeech,
  isCompanyPhoneNumber,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import {
  applyPendingQuestionAnswer,
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "./multi-field-extraction.js";
import { REALTIME_ANYTHING_ELSE_QUESTION, type RealtimeFields } from "./realtime-prompts.js";
import {
  applyDirectAnswerToMissingField,
  getMissingRequiredFields,
  getNaturalTransitionQuestion,
  getNextRequiredField,
  getRequiredFieldQuestion,
  getSharedMissingFields,
  isCallerNameResolved,
  isRequiredIntakeComplete,
  isSharedIntakeComplete,
  needsCallbackReadback,
  type RequiredFieldKey,
} from "./required-intake.js";
import {
  needsScheduleClarification,
  needsScheduleConfirmation,
  processScheduleCapture,
} from "./schedule-normalizer.js";
import {
  isStructuredBooleanUnset,
  normalizeTriStateField,
  shouldCollectAdjuster,
  syncLegacyStringFields,
  toCollectedFields,
} from "./structured-intake.js";
import type { PendingQuestionKey } from "./pending-question.js";
import { resolvePendingQuestion } from "./pending-question.js";
import {
  isPhotosFieldComplete,
  normalizePhotosValue,
} from "./photos-field.js";
import { preserveConfirmedFieldState } from "./safe-field-merge.js";
import type { ConversationState } from "./conversation-state.js";

export type RealtimeIntakeStage = RequiredFieldKey;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRealtimeIntakeComplete(fields: RealtimeFields): boolean {
  return isRequiredIntakeComplete(fields);
}

export function getRealtimeNextMissingStage(
  fields: RealtimeFields,
): RequiredFieldKey | "wrap_up" {
  const next = getNextRequiredField(fields);
  return next ?? "wrap_up";
}

export {
  getMissingRequiredFields,
  getSharedMissingFields,
  isRequiredIntakeComplete,
  isSharedIntakeComplete,
  isCallerNameResolved,
  needsCallbackReadback,
  needsAddressReadback,
};

export function mergeRealtimeCallerAnswer(
  fields: RealtimeFields,
  answer: string,
  callerPhone?: string,
  options: {
    pendingQuestion?: PendingQuestionKey | null;
    conversationState?: ConversationState;
  } = {},
): RealtimeFields {
  const pendingQuestion =
    options.pendingQuestion ??
    resolvePendingQuestion(
      fields,
      options.conversationState ?? "collecting_intake",
    );

  let updated = applyPendingQuestionAnswer(fields, answer, callerPhone, pendingQuestion);

  const extracted = extractAllFieldsFromTranscript(answer, callerPhone, pendingQuestion);
  updated = mergeExtractedFields(updated, extracted);

  const missingBeforeDirect = getMissingRequiredFields(updated);
  if (missingBeforeDirect.length > 0) {
    updated = applyDirectAnswerToMissingField(
      updated,
      answer,
      callerPhone,
      pendingQuestion,
    );
  }

  if (
    hasValue(updated.appointment_preference_raw) &&
    updated.schedule_confirmed !== true
  ) {
    updated = processScheduleCapture(updated, answer).fields;
  }

  return preserveConfirmedFieldState(fields, updated);
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

export function getRealtimeStageQuestion(
  stage: RequiredFieldKey | "wrap_up",
  fields: RealtimeFields = {},
  callerPhone?: string,
): string {
  if (stage === "wrap_up") {
    return REALTIME_ANYTHING_ELSE_QUESTION;
  }

  return getNaturalTransitionQuestion(stage, fields, callerPhone);
}

export function buildRealtimeAcknowledgment(
  policy: AcknowledgmentPolicy,
  answer: string,
  fields: RealtimeFields,
  filledCount: number,
  nextField?: RequiredFieldKey,
  afterConfirmation = false,
): string | null {
  return policy.selectAcknowledgment({
    nextField,
    answer,
    isEmergency: detectEmergency(answer),
    emergencyAlreadyAcknowledged: fields.emergency_acknowledged === true,
    filledCount,
    afterConfirmation,
  });
}

export function buildIntakeReply(
  policy: AcknowledgmentPolicy,
  fields: RealtimeFields,
  answer: string,
  callerPhone: string | undefined,
  filledCount: number,
  afterConfirmation = false,
): string {
  const nextField = getNextRequiredField(fields);

  if (!nextField) {
    return REALTIME_ANYTHING_ELSE_QUESTION;
  }

  const question = getNaturalTransitionQuestion(nextField, fields, callerPhone);
  const ack = buildRealtimeAcknowledgment(
    policy,
    answer,
    fields,
    filledCount,
    nextField,
    afterConfirmation,
  );
  const fallback = getRequiredFieldQuestion(nextField, fields, callerPhone);
  const combined = joinAcknowledgmentAndQuestion(ack, question);

  return guardIntakeReply(combined, fallback);
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
  const beforeMissing = new Set(getMissingRequiredFields(before));
  const afterMissing = new Set(getMissingRequiredFields(after));

  let count = 0;

  for (const field of beforeMissing) {
    if (!afterMissing.has(field)) {
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
    photos_available: normalizePhotosValue(fields.photos_available),
    emergency_or_active_leak:
      fields.emergency_or_active_leak ?? normalizeTriStateField(fields.active_leak),
  };
}

export function toPersistedFields(fields: RealtimeFields): CollectedFields {
  return toCollectedFields(normalizeRealtimeFields(fields));
}

export {
  buildAddressReadbackConfirmation,
  buildCallbackReadbackConfirmation,
  needsScheduleClarification,
  needsScheduleConfirmation,
  shouldCollectAdjuster,
};
