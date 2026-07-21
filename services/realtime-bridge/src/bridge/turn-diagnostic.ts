import type { ConversationState } from "../orchestrator/conversation-state.js";
import type { RealtimeFields } from "../orchestrator/realtime-prompts.js";
import {
  getNextRequiredField,
  needsImmediateSafetyClarification,
  isCallerNameResolved,
  isCallbackPhoneResolved,
} from "../orchestrator/required-intake.js";
import {
  needsCallbackConfirmation,
  needsAddressConfirmation,
  resolvePendingQuestion,
} from "../orchestrator/pending-question.js";
import { needsAddressReadback } from "../orchestrator/address-confirmation.js";
import {
  needsScheduleClarification,
  needsScheduleConfirmation,
} from "../orchestrator/schedule-normalizer.js";
import { logInfo, logWarn } from "../logger.js";

export type TurnStateSnapshot = {
  pendingQuestion: string | null;
  callbackPhonePresent: boolean;
  callbackPhoneConfirmed: boolean | null;
  addressPresent: boolean;
  addressConfirmed: boolean | null;
  photosAvailable: string | null;
  insuranceClaimStarted: boolean | null;
  adjusterContacted: boolean | null;
  scheduleConfirmed: boolean | null;
  appointmentPreference: string | null;
  nextRequiredField: string | null;
  needsCallbackConfirmation: boolean;
  needsAddressConfirmation: boolean;
};

export type FieldUpdateRecord = {
  field: string;
  before: string | boolean | null;
  after: string | boolean | null;
  accepted: boolean;
};

type ActiveTurnContext = {
  callId: string;
  turnId: number;
};

let activeTurn: ActiveTurnContext | null = null;
let lastTurnSnapshot: TurnStateSnapshot | null = null;
let lastConversationState: ConversationState | null = null;
let lastPendingQuestion: string | null = null;

const TRACKED_FIELD_KEYS: (keyof RealtimeFields)[] = [
  "full_name",
  "problem_description",
  "callback_phone",
  "callback_phone_confirmed",
  "address",
  "address_confirmed",
  "photos_available",
  "insurance_claim_started",
  "adjuster_contacted",
  "appointment_preference",
  "appointment_preference_raw",
  "schedule_confirmed",
  "pending_question",
  "additional_notes_responded",
  "summary_confirmed",
];

function formatTrackedValue(value: unknown): string | boolean | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "boolean" || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  return String(value);
}

function maskPhone(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const digits = value.replace(/\D/g, "");

  if (digits.length >= 4) {
    return `***${digits.slice(-4)}`;
  }

  return "***";
}

function formatPhotosValue(value: RealtimeFields["photos_available"]): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value);
}

export function isTurnDiagnosticsEnabled(): boolean {
  const explicit = process.env.REALTIME_TURN_DIAGNOSTICS?.trim().toLowerCase();

  if (explicit === "true" || explicit === "1") {
    return true;
  }

  if (explicit === "false" || explicit === "0") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

export function snapshotTurnState(
  fields: RealtimeFields,
  conversationState: ConversationState,
): TurnStateSnapshot {
  const nextRequired = getNextRequiredField(fields);

  return {
    pendingQuestion: fields.pending_question?.trim() ?? resolvePendingQuestion(fields, conversationState),
    callbackPhonePresent: Boolean(fields.callback_phone?.trim()),
    callbackPhoneConfirmed:
      fields.callback_phone_confirmed === undefined ? null : fields.callback_phone_confirmed,
    addressPresent: Boolean(fields.address?.trim()),
    addressConfirmed: fields.address_confirmed === undefined ? null : fields.address_confirmed,
    photosAvailable: formatPhotosValue(fields.photos_available),
    insuranceClaimStarted:
      fields.insurance_claim_started === undefined ? null : fields.insurance_claim_started,
    adjusterContacted:
      fields.adjuster_contacted === undefined ? null : fields.adjuster_contacted,
    scheduleConfirmed: fields.schedule_confirmed === undefined ? null : fields.schedule_confirmed,
    appointmentPreference: fields.appointment_preference?.trim() ?? null,
    nextRequiredField: nextRequired,
    needsCallbackConfirmation: needsCallbackConfirmation(fields),
    needsAddressConfirmation: needsAddressConfirmation(fields),
  };
}

export function diffTrackedFields(
  before: RealtimeFields,
  after: RealtimeFields,
): FieldUpdateRecord[] {
  const updates: FieldUpdateRecord[] = [];

  for (const field of TRACKED_FIELD_KEYS) {
    const beforeValue = formatTrackedValue(before[field]);
    const afterValue = formatTrackedValue(after[field]);

    if (beforeValue === afterValue) {
      continue;
    }

    updates.push({
      field,
      before: beforeValue,
      after: afterValue,
      accepted: true,
    });
  }

  return updates;
}

export function beginTurnDiagnostic(callId: string, turnId: number): void {
  if (!isTurnDiagnosticsEnabled()) {
    return;
  }

  activeTurn = { callId, turnId };
}

export function clearTurnDiagnostic(): void {
  activeTurn = null;
}

export function logTurnDiagnostic(event: string, fields: Record<string, unknown>): void {
  if (!isTurnDiagnosticsEnabled()) {
    return;
  }

  logInfo(event, {
    callId: activeTurn?.callId,
    turnId: activeTurn?.turnId,
    ...fields,
  });
}

export function logTurnStart(input: {
  callId: string;
  turnId: number;
  transcript: string;
  conversationState: ConversationState;
  fieldsBefore: RealtimeFields;
}): TurnStateSnapshot {
  beginTurnDiagnostic(input.callId, input.turnId);
  lastConversationState = input.conversationState;
  lastPendingQuestion = input.fieldsBefore.pending_question?.trim() ?? null;

  const before = snapshotTurnState(input.fieldsBefore, input.conversationState);
  lastTurnSnapshot = before;

  logTurnDiagnostic("turn_diag_start", {
    callerTranscript: input.transcript,
    conversationStateBefore: input.conversationState,
    pendingQuestionBefore: before.pendingQuestion,
    callbackPhoneBefore: maskPhone(input.fieldsBefore.callback_phone),
    callbackPhoneConfirmedBefore: before.callbackPhoneConfirmed,
    photosStateBefore: before.photosAvailable,
    insuranceStateBefore: before.insuranceClaimStarted,
    schedulingStateBefore: {
      scheduleConfirmed: before.scheduleConfirmed,
      appointmentPreference: before.appointmentPreference,
    },
    stateBefore: before,
  });

  return before;
}

export function logAnswerHandler(input: {
  handler: string;
  pendingQuestion: string | null;
  shortAnswer: boolean;
  fieldUpdates: FieldUpdateRecord[];
  rejectedUpdates?: FieldUpdateRecord[];
}): void {
  logTurnDiagnostic("turn_diag_answer_handler", {
    handlerChosen: input.handler,
    pendingQuestionUsed: input.pendingQuestion,
    shortAnswer: input.shortAnswer,
    validatedFieldUpdates: input.fieldUpdates,
    rejectedFieldUpdates: input.rejectedUpdates ?? [],
  });
}

export function logTurnStateAfterMerge(input: {
  fieldsAfter: RealtimeFields;
  conversationState: ConversationState;
}): TurnStateSnapshot {
  const after = snapshotTurnState(input.fieldsAfter, input.conversationState);
  lastTurnSnapshot = after;
  lastPendingQuestion = input.fieldsAfter.pending_question?.trim() ?? null;

  logTurnDiagnostic("turn_diag_state_after_merge", {
    stateAfter: after,
    callbackPhoneAfter: maskPhone(input.fieldsAfter.callback_phone),
    callbackPhoneConfirmedAfter: after.callbackPhoneConfirmed,
    pendingQuestionAfter: after.pendingQuestion,
  });

  return after;
}

export function logNextActionSelection(input: {
  nextAction: string;
  reason: string;
  nextConversationState: ConversationState;
  pendingQuestionAfter: string | null;
  replyPreview: string;
}): void {
  lastConversationState = input.nextConversationState;
  lastPendingQuestion = input.pendingQuestionAfter;

  logTurnDiagnostic("turn_diag_next_action", {
    nextActionSelected: input.nextAction,
    nextActionReason: input.reason,
    nextConversationState: input.nextConversationState,
    pendingQuestionAfter: input.pendingQuestionAfter,
    replyPreview: input.replyPreview.slice(0, 160),
  });
}

export function explainPostIntakeBranch(
  fields: RealtimeFields,
  options: { isFirstCallerTurn?: boolean; afterConfirmation?: boolean },
): { action: string; reason: string } {
  const nextRequired = getNextRequiredField(fields);

  if (
    options.isFirstCallerTurn === true &&
    fields.intake_intro_delivered !== true &&
    fields.problem_description?.trim() &&
    (nextRequired === "full_name" || nextRequired === "emergency_or_active_leak")
  ) {
    return {
      action: "first_turn_intro",
      reason: `first caller turn with nextRequired=${nextRequired}`,
    };
  }

  if (
    isCallerNameResolved(fields) &&
    needsCallbackConfirmation(fields) &&
    nextRequired === "callback_phone" &&
    !needsImmediateSafetyClarification(fields)
  ) {
    return {
      action: "callback_confirmation_readback",
      reason: `needsCallbackConfirmation=true callbackPhoneConfirmed=${String(fields.callback_phone_confirmed)} nextRequired=${nextRequired}`,
    };
  }

  if (
    isCallerNameResolved(fields) &&
    isCallbackPhoneResolved(fields) &&
    needsAddressReadback(fields) &&
    nextRequired === "address"
  ) {
    return {
      action: "address_confirmation_readback",
      reason: `needsAddressReadback=true addressConfirmed=${String(fields.address_confirmed)} nextRequired=${nextRequired}`,
    };
  }

  if (needsScheduleClarification(fields)) {
    return {
      action: "schedule_clarification",
      reason: "needsScheduleClarification=true",
    };
  }

  if (needsScheduleConfirmation(fields)) {
    return {
      action: "schedule_confirmation",
      reason: "needsScheduleConfirmation=true",
    };
  }

  return {
    action: "standard_intake_question",
    reason: `nextRequired=${nextRequired ?? "wrap_up"}`,
  };
}

export function logResponseCreateSent(): void {
  logTurnDiagnostic("turn_diag_response_create_sent", {
    responseCreateSent: true,
  });
}

export function logFirstAssistantAudioReceived(): void {
  logTurnDiagnostic("turn_diag_first_audio_received", {
    firstAssistantAudioReceived: true,
  });
}

export function logCallDisconnect(input: {
  callId?: string;
  reason: string;
  conversationState?: ConversationState | null;
  lastPendingQuestion?: string | null;
  lastSnapshot?: TurnStateSnapshot | null;
  callerHeardMessage?: boolean;
  leadPreserved?: boolean;
}): void {
  if (!isTurnDiagnosticsEnabled()) {
    logInfo("call_bridge_cleanup", { reason: input.reason, callSid: input.callId });
    return;
  }

  logWarn("turn_diag_call_disconnect", {
    callId: input.callId,
    disconnectReason: input.reason,
    lastConversationState: input.conversationState ?? lastConversationState,
    lastPendingQuestion: input.lastPendingQuestion ?? lastPendingQuestion,
    lastCallbackPhoneConfirmed:
      input.lastSnapshot?.callbackPhoneConfirmed ?? lastTurnSnapshot?.callbackPhoneConfirmed,
    lastState: input.lastSnapshot ?? lastTurnSnapshot,
    callerHeardMessage: input.callerHeardMessage ?? false,
    leadPreserved: input.leadPreserved ?? true,
  });

  clearTurnDiagnostic();
}

export function getLastTurnDiagnosticSnapshot(): TurnStateSnapshot | null {
  return lastTurnSnapshot;
}
