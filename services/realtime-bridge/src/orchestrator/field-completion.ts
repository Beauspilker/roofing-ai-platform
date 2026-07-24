import type { RealtimeFields } from "./realtime-prompts.js";
import { isAddressConfirmed, hasConfirmableAddress } from "./address-confirmation.js";
import { isScheduleComplete } from "./schedule-normalizer.js";
import {
  isStructuredBooleanUnset,
  type TriStateBoolean,
} from "./structured-intake.js";
import type { RequiredFieldKey } from "./required-intake.js";
import { hasCompleteCallerName } from "./caller-name-intake.js";

export type FieldCompletionStatus = "missing" | "captured" | "uncertain" | "confirmed";

export const MAX_FIELD_CLARIFICATION_ATTEMPTS = 2;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolutionStatus(
  fields: RealtimeFields,
  field: RequiredFieldKey,
): FieldCompletionStatus | undefined {
  return fields.field_resolution?.[field];
}

export function getFieldClarificationAttempts(
  fields: RealtimeFields,
  field: RequiredFieldKey,
): number {
  return fields.field_clarification_attempts?.[field] ?? 0;
}

export function incrementFieldClarificationAttempt(
  fields: RealtimeFields,
  field: RequiredFieldKey,
): RealtimeFields {
  const attempts = getFieldClarificationAttempts(fields, field) + 1;

  return {
    ...fields,
    field_clarification_attempts: {
      ...fields.field_clarification_attempts,
      [field]: attempts,
    },
  };
}

export function markFieldUncertain(
  fields: RealtimeFields,
  field: RequiredFieldKey,
  callerWording?: string,
): RealtimeFields {
  const note = callerWording?.trim();
  const existingNotes = fields.additional_notes?.trim();
  const combinedNotes =
    note && existingNotes && !existingNotes.includes(note)
      ? `${existingNotes} ${note}`
      : note ?? existingNotes;

  return {
    ...fields,
    field_resolution: {
      ...fields.field_resolution,
      [field]: "uncertain",
    },
    additional_notes: combinedNotes ? combinedNotes.slice(0, 500) : fields.additional_notes,
  };
}

export function markFieldCaptured(
  fields: RealtimeFields,
  field: RequiredFieldKey,
): RealtimeFields {
  return {
    ...fields,
    field_resolution: {
      ...fields.field_resolution,
      [field]: "captured",
    },
  };
}

export function markFieldConfirmed(
  fields: RealtimeFields,
  field: RequiredFieldKey,
): RealtimeFields {
  return {
    ...fields,
    field_resolution: {
      ...fields.field_resolution,
      [field]: "confirmed",
    },
  };
}

function isCallbackComplete(fields: RealtimeFields): boolean {
  return hasValue(fields.callback_phone) && fields.callback_phone_confirmed === true;
}

export function getFieldCompletionStatus(
  field: RequiredFieldKey,
  fields: RealtimeFields,
): FieldCompletionStatus {
  const explicit = resolutionStatus(fields, field);
  if (explicit) {
    return explicit;
  }

  switch (field) {
    case "full_name":
      if (fields.caller_name_declined === true || fields.caller_name_unavailable === true) {
        return "confirmed";
      }
      if (hasCompleteCallerName(fields)) {
        return fields.name_pending_confirmation ? "captured" : "confirmed";
      }
      return "missing";
    case "callback_phone":
      if (isCallbackComplete(fields)) {
        return "confirmed";
      }
      if (hasValue(fields.callback_phone)) {
        return "captured";
      }
      return "missing";
    case "address":
      if (isAddressConfirmed(fields)) {
        return "confirmed";
      }
      if (hasConfirmableAddress(fields.address)) {
        return "captured";
      }
      return "missing";
    case "problem_description":
      return hasValue(fields.problem_description) ? "captured" : "missing";
    case "urgency":
      return hasValue(fields.urgency) ? "captured" : "missing";
    case "appointment_preference":
      if (isScheduleComplete(fields)) {
        return fields.schedule_confirmed === true ? "confirmed" : "captured";
      }
      if (hasValue(fields.appointment_preference_raw)) {
        return "captured";
      }
      return "missing";
    case "emergency_or_active_leak":
    case "insurance_claim_started":
    case "adjuster_contacted":
      return booleanFieldStatus(fields[field]);
    default:
      return "missing";
  }
}

function booleanFieldStatus(value: TriStateBoolean | undefined): FieldCompletionStatus {
  if (value === true || value === false) {
    return "captured";
  }
  return "missing";
}

export function isFieldResolvedEnoughToSkip(
  field: RequiredFieldKey,
  fields: RealtimeFields,
): boolean {
  const status = getFieldCompletionStatus(field, fields);

  if (status === "confirmed" || status === "uncertain") {
    return true;
  }

  if (status === "captured") {
    switch (field) {
      case "full_name":
        return hasCompleteCallerName(fields);
      case "callback_phone":
        return isCallbackComplete(fields);
      case "address":
        return isAddressConfirmed(fields);
      case "problem_description":
      case "urgency":
        return true;
      case "appointment_preference":
        return isScheduleComplete(fields);
      case "emergency_or_active_leak":
      case "insurance_claim_started":
      case "adjuster_contacted":
        return !isStructuredBooleanUnset(fields[field]);
      default:
        return false;
    }
  }

  if (getFieldClarificationAttempts(fields, field) >= MAX_FIELD_CLARIFICATION_ATTEMPTS) {
    return true;
  }

  return false;
}

export function isFieldAskable(field: RequiredFieldKey, fields: RealtimeFields): boolean {
  return !isFieldResolvedEnoughToSkip(field, fields);
}

export function mapPendingQuestionToRequiredField(
  pending: string | undefined,
): RequiredFieldKey | null {
  switch (pending) {
    case "caller_name":
      return "full_name";
    case "callback_phone":
    case "callback_confirmation":
      return "callback_phone";
    case "service_address":
    case "address_confirmation":
      return "address";
    case "reason_for_call":
    case "call_reason":
      return "problem_description";
    case "insurance_claim":
      return "insurance_claim_started";
    case "adjuster_contacted":
      return "adjuster_contacted";
    case "active_leak":
      return "emergency_or_active_leak";
    case "urgency":
      return "urgency";
    case "preferred_callback_time":
    case "schedule_confirmation":
      return "appointment_preference";
    default:
      return null;
  }
}

export function appendContextNote(
  fields: RealtimeFields,
  note: string,
): RealtimeFields {
  const trimmed = note.trim();
  if (!trimmed) {
    return fields;
  }

  const existing = fields.additional_notes?.trim();
  if (existing?.includes(trimmed)) {
    return fields;
  }

  const combined = existing ? `${existing} ${trimmed}` : trimmed;

  return {
    ...fields,
    additional_notes: combined.slice(0, 500),
  };
}
