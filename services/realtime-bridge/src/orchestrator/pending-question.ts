import type { RealtimeFields } from "./realtime-prompts.js";
import { hasConfirmableAddress, isAddressConfirmed } from "./address-confirmation.js";
import {
  needsScheduleClarification,
  needsScheduleConfirmation,
} from "./schedule-normalizer.js";
import {
  getNextRequiredField,
  isCallerNameResolved,
  isCallbackPhoneResolved,
  needsImmediateSafetyClarification,
  type RequiredFieldKey,
} from "./required-intake.js";
import type { ConversationState } from "./conversation-state.js";

export type PendingQuestionKey =
  | "caller_name"
  | "callback_phone"
  | "callback_confirmation"
  | "service_address"
  | "address_confirmation"
  | "reason_for_call"
  | "call_reason"
  | "insurance_claim"
  | "adjuster_contacted"
  | "active_leak"
  | "urgency"
  | "preferred_callback_time"
  | "schedule_confirmation"
  | "additional_notes"
  | "summary_confirmation";

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function needsCallbackConfirmation(fields: RealtimeFields): boolean {
  return Boolean(
    hasValue(fields.callback_phone) && fields.callback_phone_confirmed !== true,
  );
}

export function needsAddressConfirmation(fields: RealtimeFields): boolean {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed !== true;
}

export function mapRequiredFieldToPending(field: RequiredFieldKey): PendingQuestionKey {
  switch (field) {
    case "problem_description":
      return "reason_for_call";
    case "full_name":
      return "caller_name";
    case "callback_phone":
      return "callback_phone";
    case "address":
      return "service_address";
    case "emergency_or_active_leak":
      return "active_leak";
    case "urgency":
      return "urgency";
    case "insurance_claim_started":
      return "insurance_claim";
    case "adjuster_contacted":
      return "adjuster_contacted";
    case "appointment_preference":
      return "preferred_callback_time";
    default:
      return "reason_for_call";
  }
}

export function isPendingQuestionKey(value: string): value is PendingQuestionKey {
  return (
    value === "caller_name" ||
    value === "callback_phone" ||
    value === "callback_confirmation" ||
    value === "service_address" ||
    value === "address_confirmation" ||
    value === "reason_for_call" ||
    value === "call_reason" ||
    value === "insurance_claim" ||
    value === "adjuster_contacted" ||
    value === "active_leak" ||
    value === "urgency" ||
    value === "preferred_callback_time" ||
    value === "schedule_confirmation" ||
    value === "additional_notes" ||
    value === "summary_confirmation"
  );
}

function isStoredPendingQuestionStillValid(
  fields: RealtimeFields,
  pending: PendingQuestionKey,
): boolean {
  switch (pending) {
    case "callback_confirmation":
      return needsCallbackConfirmation(fields);
    case "address_confirmation":
      return needsAddressConfirmation(fields);
    case "preferred_callback_time":
      return needsScheduleClarification(fields);
    case "schedule_confirmation":
      return needsScheduleConfirmation(fields);
    default:
      return true;
  }
}

export function resolvePendingQuestion(
  fields: RealtimeFields,
  conversationState: ConversationState,
): PendingQuestionKey | null {
  const stored = fields.pending_question?.trim();

  if (stored && isPendingQuestionKey(stored) && isStoredPendingQuestionStillValid(fields, stored)) {
    return stored;
  }

  if (conversationState === "awaiting_callback_confirmation") {
    return "callback_confirmation";
  }

  if (conversationState === "awaiting_address_confirmation") {
    return "address_confirmation";
  }

  if (conversationState === "awaiting_schedule_clarification") {
    return "preferred_callback_time";
  }

  if (conversationState === "awaiting_schedule_confirmation") {
    return "schedule_confirmation";
  }

  if (conversationState === "awaiting_additional_notes") {
    return "additional_notes";
  }

  if (
    conversationState === "awaiting_summary_confirmation" ||
    conversationState === "handling_correction" ||
    conversationState === "presenting_summary"
  ) {
    return "summary_confirmation";
  }

  const nextRequired = getNextRequiredField(fields);

  if (
    needsCallbackConfirmation(fields) &&
    nextRequired === "callback_phone" &&
    isCallerNameResolved(fields) &&
    !needsImmediateSafetyClarification(fields)
  ) {
    return "callback_confirmation";
  }

  if (
    needsAddressConfirmation(fields) &&
    nextRequired === "address" &&
    isCallbackPhoneResolved(fields) &&
    isCallerNameResolved(fields)
  ) {
    return "address_confirmation";
  }

  if (needsScheduleClarification(fields) || needsScheduleConfirmation(fields)) {
    return needsScheduleConfirmation(fields)
      ? "schedule_confirmation"
      : "preferred_callback_time";
  }

  return nextRequired ? mapRequiredFieldToPending(nextRequired) : null;
}

export function pendingQuestionForConversationState(
  conversationState: ConversationState,
): PendingQuestionKey | null {
  switch (conversationState) {
    case "awaiting_callback_confirmation":
      return "callback_confirmation";
    case "awaiting_address_confirmation":
      return "address_confirmation";
    case "awaiting_schedule_clarification":
      return "preferred_callback_time";
    case "awaiting_schedule_confirmation":
      return "schedule_confirmation";
    case "awaiting_additional_notes":
      return "additional_notes";
    case "awaiting_summary_confirmation":
    case "handling_correction":
    case "presenting_summary":
      return "summary_confirmation";
    default:
      return null;
  }
}

export function pendingQuestionForNextField(
  field: RequiredFieldKey | null,
): PendingQuestionKey | null {
  return field ? mapRequiredFieldToPending(field) : null;
}

export function attachPendingQuestion(
  fields: RealtimeFields,
  pendingQuestion: PendingQuestionKey | null,
): RealtimeFields {
  if (!pendingQuestion) {
    return {
      ...fields,
      pending_question: undefined,
    };
  }

  return {
    ...fields,
    pending_question: pendingQuestion,
  };
}

export function allowsCallbackAffirmativeReuse(
  pendingQuestion: PendingQuestionKey | null,
): boolean {
  return pendingQuestion === "callback_phone" || pendingQuestion === "callback_confirmation";
}

export function allowsBooleanDirectAnswer(
  pendingQuestion: PendingQuestionKey | null,
  field: PendingQuestionKey,
): boolean {
  return pendingQuestion === field;
}

export function resolveActivePendingQuestion(
  fields: RealtimeFields,
  conversationState: ConversationState,
  override?: PendingQuestionKey | null,
): PendingQuestionKey | null {
  if (override !== undefined) {
    return override;
  }

  const stored = fields.pending_question?.trim();

  if (stored && isPendingQuestionKey(stored) && isStoredPendingQuestionStillValid(fields, stored)) {
    return stored;
  }

  return resolvePendingQuestion(fields, conversationState);
}
