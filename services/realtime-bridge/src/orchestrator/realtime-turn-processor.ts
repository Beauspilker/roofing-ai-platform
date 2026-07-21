import {
  buildNameConfirmationPrompt,
  buildNameRepeatPrompt,
  isAwaitingNameConfirmation,
  processNameCaptureTurn,
} from "../../../../lib/call-name-capture.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import {
  completeCallSession,
  createTranscriptEntry,
  type CallSession,
  updateCallSession,
} from "../../../../lib/call-sessions.js";
import { isExplicitCallerHangupDuringIntake } from "../../../../lib/twilio/voice-phrases.js";
import type { AcknowledgmentPolicy } from "./acknowledgment-policy.js";
import {
  isCallbackConfirmed,
  isCallbackRejected,
} from "./callback-phone.js";
import type { ConversationState } from "./conversation-state.js";
import {
  appendAnythingElseNotes,
  applyCallbackCorrection,
  buildCallbackReadbackConfirmation,
  buildIntakeReply,
  confirmCallbackPhone,
  countNewlyFilledFields,
  getMissingRequiredFields,
  getSharedMissingFields,
  getRealtimeNextMissingStage,
  mergeRealtimeCallerAnswer,
  needsCallbackReadback,
  needsAddressReadback,
  needsScheduleClarification,
  needsScheduleConfirmation,
  normalizeRealtimeFields,
  toPersistedFields,
} from "./realtime-intake.js";
import {
  applyAddressCorrection,
  buildAddressReadbackConfirmation,
  confirmAddress,
  isAddressConfirmedSpeech,
  isAddressRejectedSpeech,
} from "./address-confirmation.js";
import {
  buildScheduleConfirmationQuestion,
  confirmSchedule,
  isScheduleConfirmedSpeech,
  isScheduleRejectedSpeech,
  processScheduleCapture,
  SCHEDULE_PARSE_FALLBACK_PROMPT,
} from "./schedule-normalizer.js";
import {
  buildClosingMessage,
  buildStructuredSpokenSummary,
  buildSummaryWithConfirmation,
  ensureSingleIntakeQuestion,
  isAnythingElseDeclined,
  isSummaryConfirmed,
  isSummaryRejected,
  REALTIME_ANYTHING_ELSE_QUESTION,
  REALTIME_INTRO_TRANSITION,
  type RealtimeFields,
} from "./realtime-prompts.js";
import {
  canAdvanceAfterOpening,
  isMeaningfulOpeningCallerTranscript,
  OpeningSilenceController,
  type OpeningSilencePrompt,
} from "../bridge/opening-listening.js";
import {
  applyCallReasonCapture,
  isPendingCallReasonQuestion,
  resolveCallReasonClarificationReply,
} from "./call-reason-handling.js";
import {
  buildNameClarificationPrompt,
  EARLY_CALLER_NAME_QUESTION,
  isLikelyCallReasonSpeech,
  isOpeningReasonCaptureContext,
  isPlausibleCallerName,
} from "./field-validation.js";
import {
  attachPendingQuestion,
  pendingQuestionForConversationState,
  pendingQuestionForNextField,
  resolvePendingQuestion,
} from "./pending-question.js";
import {
  getNaturalTransitionQuestion,
  getNextRequiredField,
  getSharedMissingFields,
  isCallerNameResolved,
  isCallbackPhoneResolved,
  isSharedIntakeComplete,
  needsImmediateSafetyClarification,
} from "./required-intake.js";
import { applyCorrectionToStructuredField, syncLegacyStringFields } from "./structured-intake.js";
import { logError } from "../logger.js";
import {
  explainPostIntakeBranch,
  isTurnDiagnosticsEnabled,
  logNextActionSelection,
  logTurnStart,
  logTurnStateAfterMerge,
} from "../bridge/turn-diagnostic.js";

export type RealtimeTurnOutcome = {
  replyText: string;
  hangup: boolean;
  hangupAfterMark: boolean;
  session: CallSession | null;
  nextConversationState: ConversationState;
  structuredStateUpdated?: boolean;
};

export type ProcessRealtimeTurnInput = {
  session: CallSession | null;
  callSid: string;
  callerPhone: string;
  speechResult: string;
  conversationState: ConversationState;
  acknowledgmentPolicy: AcknowledgmentPolicy;
  isFirstCallerTurn?: boolean;
  hasReceivedMeaningfulCallerTranscript?: boolean;
  turnId?: number;
};

function applyLocalSessionUpdate(
  session: CallSession,
  input: {
    collectedFields?: RealtimeFields;
    currentQuestion?: string | null;
  },
): CallSession {
  return {
    ...session,
    collected_fields: input.collectedFields
      ? toPersistedFields(input.collectedFields)
      : session.collected_fields,
    current_question: input.currentQuestion ?? session.current_question,
  };
}

async function persistTurn(
  callSid: string,
  input: {
    collectedFields?: RealtimeFields;
    currentQuestion?: string | null;
    callerSpeech: string;
    assistantReply: string;
  },
): Promise<CallSession | null> {
  const session =
    (await updateCallSession({
      callSid,
      collectedFields: input.collectedFields
        ? toPersistedFields(input.collectedFields)
        : undefined,
      currentQuestion: input.currentQuestion ?? null,
      transcriptEntry: createTranscriptEntry("caller", input.callerSpeech),
    })) ?? null;

  await updateCallSession({
    callSid,
    transcriptEntry: createTranscriptEntry("assistant", input.assistantReply),
  });

  return session;
}

function persistTurnAsync(
  callSid: string,
  input: {
    collectedFields?: RealtimeFields;
    currentQuestion?: string | null;
    callerSpeech: string;
    assistantReply: string;
  },
): void {
  void persistTurn(callSid, input).catch((error) => {
    logError("persist_turn_failed", { callSid }, error);
  });
}

function finishTurn(
  input: ProcessRealtimeTurnInput,
  outcome: Omit<RealtimeTurnOutcome, "structuredStateUpdated">,
): RealtimeTurnOutcome {
  return {
    ...outcome,
    replyText: outcome.replyText.trim(),
    structuredStateUpdated: true,
  };
}

function ensureNonEmptyReply(replyText: string, fallback: string): string {
  const trimmed = replyText.trim();
  return trimmed || fallback;
}

function clearErroneousNameCaptureForReason(fields: RealtimeFields): RealtimeFields {
  if (fields.problem_description?.trim()) {
    return fields;
  }

  const cleaned: RealtimeFields = { ...fields };

  if (cleaned.full_name && !isPlausibleCallerName(cleaned.full_name)) {
    cleaned.full_name = undefined;
  }

  const pendingName = cleaned.name_pending_confirmation?.trim();
  if (pendingName && !isPlausibleCallerName(pendingName)) {
    cleaned.name_pending_confirmation = undefined;
    cleaned.name_awaiting_repeat = undefined;
  }

  return cleaned;
}

function shouldHandlePendingCallReason(
  fields: RealtimeFields,
  conversationState: ConversationState,
): boolean {
  const pending = resolvePendingQuestion(fields, conversationState);
  return isPendingCallReasonQuestion(pending) && !fields.problem_description?.trim();
}

function buildInvalidNameCaptureRepeatOutcome(input: {
  fields: RealtimeFields;
  speech: string;
}): ReturnType<typeof processNameCaptureTurn> {
  const attempts = (input.fields.name_clarification_attempts ?? 0) + 1;

  return {
    status: "repeat",
    fields: {
      ...input.fields,
      name_pending_confirmation: undefined,
      name_awaiting_repeat: true,
      name_needs_clarification: true,
      name_clarification_attempts: attempts,
    },
    replyText: buildNameClarificationPrompt(undefined, { askToSpell: attempts >= 2 }),
    nameConfirmationRequested: false,
    nameCorrected: false,
  };
}

function processValidatedNameCaptureTurn(input: {
  fields: RealtimeFields;
  speech: string;
}): ReturnType<typeof processNameCaptureTurn> {
  const outcome = processNameCaptureTurn({
    fields: input.fields,
    speech: input.speech,
    confidence: null,
  });

  if (outcome.status === "confirm") {
    const pendingName = outcome.fields.name_pending_confirmation?.trim();

    if (pendingName && !isPlausibleCallerName(pendingName)) {
      return buildInvalidNameCaptureRepeatOutcome(input);
    }

    return outcome;
  }

  if (outcome.status !== "accepted") {
    return outcome;
  }

  const acceptedName = outcome.fields.full_name?.trim();

  if (acceptedName && isPlausibleCallerName(acceptedName)) {
    return outcome;
  }

  return buildInvalidNameCaptureRepeatOutcome(input);
}

function buildCallbackConfirmationReply(fields: RealtimeFields): string {
  return ensureSingleIntakeQuestion(
    buildCallbackReadbackConfirmation(fields.callback_phone ?? ""),
  );
}

function buildAddressConfirmationReply(fields: RealtimeFields): string {
  return ensureSingleIntakeQuestion(
    buildAddressReadbackConfirmation(fields.address ?? ""),
  );
}

function buildScheduleConfirmationReply(fields: RealtimeFields): string {
  const spoken = fields.appointment_preference?.trim();

  if (spoken?.startsWith("Would ")) {
    return ensureSingleIntakeQuestion(spoken);
  }

  const label =
    spoken || fields.appointment_preference_raw?.trim() || "the requested time";

  return ensureSingleIntakeQuestion(buildScheduleConfirmationQuestion(label));
}

function finalizeIntakeFields(
  fields: RealtimeFields,
  nextState: ConversationState,
): RealtimeFields {
  const statePending = pendingQuestionForConversationState(nextState);

  if (statePending) {
    return attachPendingQuestion(fields, statePending);
  }

  return attachPendingQuestion(fields, pendingQuestionForNextField(getNextRequiredField(fields)));
}

function packagePostIntakeResult(
  fields: RealtimeFields,
  replyText: string,
  nextState: ConversationState,
  options: { isFirstCallerTurn?: boolean; afterConfirmation?: boolean } = {},
): { replyText: string; fields: RealtimeFields; nextState: ConversationState } {
  const finalized = finalizeIntakeFields(fields, nextState);

  if (isTurnDiagnosticsEnabled()) {
    const branch = explainPostIntakeBranch(fields, options);
    logNextActionSelection({
      nextAction: branch.action,
      reason: branch.reason,
      nextConversationState: nextState,
      pendingQuestionAfter: finalized.pending_question?.trim() ?? null,
      replyPreview: replyText,
    });
  }

  return {
    replyText,
    fields: finalized,
    nextState,
  };
}

function buildPostIntakeReply(
  policy: AcknowledgmentPolicy,
  fieldsBefore: RealtimeFields,
  updatedFields: RealtimeFields,
  trimmedSpeech: string,
  callerPhone: string,
  filledCount: number,
  options: { afterConfirmation?: boolean; isFirstCallerTurn?: boolean; hasReceivedMeaningfulCallerTranscript?: boolean } = {},
): { replyText: string; fields: RealtimeFields; nextState: ConversationState } {
  const nextRequired = getNextRequiredField(updatedFields);

  if (
    options.isFirstCallerTurn === true &&
    canAdvanceAfterOpening(updatedFields, {
      hasReceivedMeaningfulCallerTranscript: options.hasReceivedMeaningfulCallerTranscript,
    }) &&
    updatedFields.intake_intro_delivered !== true &&
    updatedFields.problem_description?.trim() &&
    (nextRequired === "full_name" || nextRequired === "emergency_or_active_leak")
  ) {
    const question =
      nextRequired === "full_name"
        ? EARLY_CALLER_NAME_QUESTION
        : getNaturalTransitionQuestion(nextRequired, updatedFields, callerPhone);

    return packagePostIntakeResult(
      {
        ...updatedFields,
        intake_intro_delivered: true,
      },
      ensureSingleIntakeQuestion(
        `${REALTIME_INTRO_TRANSITION} ${question}`.replace(/\s+/g, " ").trim(),
      ),
      "collecting_intake",
      options,
    );
  }

  if (
    isCallerNameResolved(updatedFields) &&
    !needsImmediateSafetyClarification(updatedFields) &&
    needsCallbackReadback(updatedFields) &&
    nextRequired === "callback_phone"
  ) {
    return packagePostIntakeResult(
      updatedFields,
      buildCallbackConfirmationReply(updatedFields),
      "awaiting_callback_confirmation",
      options,
    );
  }

  if (
    isCallerNameResolved(updatedFields) &&
    isCallbackPhoneResolved(updatedFields) &&
    needsAddressReadback(updatedFields) &&
    nextRequired === "address"
  ) {
    return packagePostIntakeResult(
      updatedFields,
      buildAddressConfirmationReply(updatedFields),
      "awaiting_address_confirmation",
      options,
    );
  }

  if (needsScheduleClarification(updatedFields)) {
    const prompt =
      updatedFields.schedule_clarification_prompt?.trim() ||
      "What time works best?";
    return packagePostIntakeResult(
      updatedFields,
      ensureSingleIntakeQuestion(prompt),
      "awaiting_schedule_clarification",
      options,
    );
  }

  if (needsScheduleConfirmation(updatedFields)) {
    return packagePostIntakeResult(
      updatedFields,
      buildScheduleConfirmationReply(updatedFields),
      "awaiting_schedule_confirmation",
      options,
    );
  }

  const missing = getMissingRequiredFields(updatedFields);
  const sharedMissing = getSharedMissingFields(updatedFields).filter(
    (field) => field !== "additionalNotes",
  );

  if (missing.length === 0 && sharedMissing.length === 0) {
    const anythingElseQuestion = REALTIME_ANYTHING_ELSE_QUESTION;
    const reply = ensureSingleIntakeQuestion(anythingElseQuestion);

    return packagePostIntakeResult(updatedFields, reply, "awaiting_additional_notes", options);
  }

  const intakeReply = buildIntakeReply(
    policy,
    updatedFields,
    trimmedSpeech,
    callerPhone,
    filledCount,
    options.afterConfirmation === true,
  );
  const combinedReply = ensureSingleIntakeQuestion(intakeReply);

  return packagePostIntakeResult(updatedFields, combinedReply, "collecting_intake", options);
}

function isNameCaptureTurn(
  fields: RealtimeFields,
  conversationState: ConversationState,
  speech: string,
  options: { isFirstCallerTurn?: boolean } = {},
): boolean {
  const pending = resolvePendingQuestion(fields, conversationState);

  if (isPendingCallReasonQuestion(pending) || !fields.problem_description?.trim()) {
    return false;
  }

  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }

  if (conversationState !== "collecting_intake") {
    return false;
  }

  if (getNextRequiredField(fields) !== "full_name") {
    return false;
  }

  if (isOpeningReasonCaptureContext(fields, options)) {
    return false;
  }

  if (isLikelyCallReasonSpeech(speech)) {
    return false;
  }

  return true;
}

export async function processRealtimeCallerTurn(
  input: ProcessRealtimeTurnInput,
): Promise<RealtimeTurnOutcome> {
  const { callSid, callerPhone, speechResult, conversationState, acknowledgmentPolicy } =
    input;
  let session = input.session;
  const trimmedSpeech = speechResult.trim();

  if (conversationState === "closing_audio_playback" || conversationState === "completed") {
    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: conversationState,
    };
  }

  if (
    isExplicitCallerHangupDuringIntake(trimmedSpeech) &&
    conversationState === "collecting_intake"
  ) {
    if (callSid) {
      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });
    }

    return finishTurn(input, {
      replyText: "Thanks for calling Beau's Roofing — have a great day.",
      hangup: true,
      hangupAfterMark: true,
      session,
      nextConversationState: "completed",
    });
  }

  if (!session || !callSid) {
    return finishTurn(input, {
      replyText: ensureSingleIntakeQuestion("What's going on with the roof?"),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake",
    });
  }

  const fieldsBefore = clearErroneousNameCaptureForReason(
    normalizeRealtimeFields((session.collected_fields ?? {}) as RealtimeFields),
  );

  if (isTurnDiagnosticsEnabled()) {
    logTurnStart({
      callId: callSid,
      turnId: input.turnId ?? 0,
      transcript: trimmedSpeech,
      conversationState,
      fieldsBefore,
    });
  }

  if (conversationState === "awaiting_callback_confirmation") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_callback_confirmation",
      };
    }

    if (isCallbackConfirmed(trimmedSpeech)) {
      const confirmedFields = confirmCallbackPhone(fieldsBefore);
      const filledCount = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount,
        { afterConfirmation: true },
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
      });

      persistTurnAsync(callSid, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post.replyText,
      });

      return finishTurn(input, {
        replyText: post.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post.nextState,
      });
    }

    if (isCallbackRejected(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyCallbackCorrection(fieldsBefore, trimmedSpeech, callerPhone);
      const reply = buildCallbackConfirmationReply(correctedFields);

      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_callback_confirmation",
      });
    }
  }

  if (conversationState === "awaiting_address_confirmation") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_address_confirmation",
      };
    }

    if (isAddressConfirmedSpeech(trimmedSpeech)) {
      const confirmedFields = confirmAddress(fieldsBefore);
      const filledCount = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount,
        { afterConfirmation: true },
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
      });

      persistTurnAsync(callSid, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post.replyText,
      });

      return finishTurn(input, {
        replyText: post.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post.nextState,
      });
    }

    if (isAddressRejectedSpeech(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyAddressCorrection(fieldsBefore, trimmedSpeech);
      const reply = buildAddressConfirmationReply(correctedFields);

      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_address_confirmation",
      });
    }
  }

  if (conversationState === "awaiting_schedule_clarification") {
    if (!trimmedSpeech) {
      return finishTurn(input, {
        replyText: SCHEDULE_PARSE_FALLBACK_PROMPT,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_clarification",
      });
    }

    const capture = processScheduleCapture(fieldsBefore, trimmedSpeech);
    let nextFields = capture.fields;

    if (capture.clarificationPrompt) {
      const reply = ensureSingleIntakeQuestion(capture.clarificationPrompt);

      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_clarification",
      });
    }

    if (capture.confirmationPrompt) {
      const reply = ensureSingleIntakeQuestion(capture.confirmationPrompt);

      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_confirmation",
      });
    }

    const filledCount = countNewlyFilledFields(fieldsBefore, nextFields);
    const post = buildPostIntakeReply(
      acknowledgmentPolicy,
      fieldsBefore,
      nextFields,
      trimmedSpeech,
      callerPhone,
      filledCount,
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
    });

    persistTurnAsync(callSid, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post.replyText,
    });

    return finishTurn(input, {
      replyText: ensureNonEmptyReply(
        post.replyText,
        SCHEDULE_PARSE_FALLBACK_PROMPT,
      ),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post.nextState,
    });
  }

  if (conversationState === "awaiting_schedule_confirmation") {
    if (!trimmedSpeech) {
      return finishTurn(input, {
        replyText: buildScheduleConfirmationReply(fieldsBefore),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_confirmation",
      });
    }

    if (isScheduleConfirmedSpeech(trimmedSpeech)) {
      const confirmedFields = confirmSchedule(fieldsBefore);
      const filledCount = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount,
        { afterConfirmation: true },
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
      });

      persistTurnAsync(callSid, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post.replyText,
      });

      return finishTurn(input, {
        replyText: post.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post.nextState,
      });
    }

    if (isScheduleRejectedSpeech(trimmedSpeech) || trimmedSpeech.length > 0) {
      const resetFields: RealtimeFields = {
        ...fieldsBefore,
        appointment_preference_raw: trimmedSpeech,
        appointment_preference: undefined,
        appointment_schedule_iso: undefined,
        appointment_schedule_iso_end: undefined,
        schedule_confirmed: false,
        schedule_pending_clarification: false,
      };
      const capture = processScheduleCapture(resetFields, trimmedSpeech);
      const nextFields = capture.fields;

      if (capture.clarificationPrompt) {
        const reply = ensureSingleIntakeQuestion(capture.clarificationPrompt);

        session = applyLocalSessionUpdate(session, {
          collectedFields: nextFields,
          currentQuestion: reply,
        });

        persistTurnAsync(callSid, {
          collectedFields: nextFields,
          currentQuestion: reply,
          callerSpeech: trimmedSpeech,
          assistantReply: reply,
        });

        return finishTurn(input, {
          replyText: reply,
          hangup: false,
          hangupAfterMark: false,
          session,
          nextConversationState: "awaiting_schedule_clarification",
        });
      }

      const reply = capture.confirmationPrompt
        ? ensureSingleIntakeQuestion(capture.confirmationPrompt)
        : ensureNonEmptyReply(
            buildScheduleConfirmationReply(nextFields),
            SCHEDULE_PARSE_FALLBACK_PROMPT,
          );

      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: capture.confirmationPrompt
          ? "awaiting_schedule_confirmation"
          : "awaiting_schedule_confirmation",
      });
    }
  }

  if (conversationState === "awaiting_additional_notes") {
    const sharedMissing = getSharedMissingFields(fieldsBefore).filter(
      (field) => field !== "additionalNotes",
    );

    if (getMissingRequiredFields(fieldsBefore).length > 0 || sharedMissing.length > 0) {
      const reply = ensureSingleIntakeQuestion(
        buildIntakeReply(acknowledgmentPolicy, fieldsBefore, trimmedSpeech, callerPhone, 0),
      );

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake",
      });
    }

    let updatedFields = syncLegacyStringFields({
      ...fieldsBefore,
      additional_notes_responded: true,
    });

    if (!isAnythingElseDeclined(trimmedSpeech)) {
      updatedFields = appendAnythingElseNotes(updatedFields, trimmedSpeech);
    }

    if (!isSharedIntakeComplete(updatedFields)) {
      const reply = ensureSingleIntakeQuestion(
        buildIntakeReply(acknowledgmentPolicy, updatedFields, trimmedSpeech, callerPhone, 0),
      );

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake",
      });
    }

    const reply = ensureSingleIntakeQuestion(buildSummaryWithConfirmation(updatedFields));
    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields,
      currentQuestion: reply,
    });

    persistTurnAsync(callSid, {
      collectedFields: updatedFields,
      currentQuestion: reply,
      callerSpeech: trimmedSpeech,
      assistantReply: reply,
    });

    return finishTurn(input, {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "presenting_summary",
    });
  }

  if (
    conversationState === "awaiting_summary_confirmation" ||
    conversationState === "handling_correction"
  ) {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_summary_confirmation",
      };
    }

    if (isSummaryConfirmed(trimmedSpeech)) {
      const confirmedFields = syncLegacyStringFields({
        ...fieldsBefore,
        summary_confirmed: true,
      });
      const reply = buildClosingMessage();
      session = applyLocalSessionUpdate(session, {
        collectedFields: confirmedFields,
        currentQuestion: null,
      });

      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });

      persistTurnAsync(callSid, {
        collectedFields: confirmedFields,
        currentQuestion: null,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: ensureSingleIntakeQuestion(reply),
        hangup: true,
        hangupAfterMark: true,
        session,
        nextConversationState: "delivering_closing",
      });
    }

    if (isSummaryRejected(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyCorrectionToStructuredField(fieldsBefore, trimmedSpeech);
      const reply = ensureSingleIntakeQuestion(
        `${buildStructuredSpokenSummary(correctedFields)} Does that sound correct now?`,
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_summary_confirmation",
      });
    }

    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "awaiting_summary_confirmation",
    };
  }

  if (shouldHandlePendingCallReason(fieldsBefore, conversationState)) {
    const capture = applyCallReasonCapture(fieldsBefore, trimmedSpeech);

    if (!capture.resolved) {
      const reply = ensureSingleIntakeQuestion(
        resolveCallReasonClarificationReply(capture.fields, trimmedSpeech),
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: capture.fields,
        currentQuestion: reply,
      });

      persistTurnAsync(callSid, {
        collectedFields: capture.fields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake",
      });
    }

    let updatedFields = syncLegacyStringFields({
      ...capture.fields,
      pending_question: undefined,
      call_reason_awaiting_clarification: false,
    });

    if (detectEmergency(trimmedSpeech) && !updatedFields.emergency_acknowledged) {
      updatedFields = {
        ...updatedFields,
        urgency: updatedFields.urgency ?? "emergency",
        emergency_acknowledged: true,
      };
    }

    const filledCount = countNewlyFilledFields(fieldsBefore, updatedFields);
    const post = buildPostIntakeReply(
      acknowledgmentPolicy,
      fieldsBefore,
      updatedFields,
      trimmedSpeech,
      callerPhone,
      filledCount,
      {
        isFirstCallerTurn: input.isFirstCallerTurn,
        hasReceivedMeaningfulCallerTranscript: input.hasReceivedMeaningfulCallerTranscript,
      },
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
    });

    persistTurnAsync(callSid, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post.replyText,
    });

    return finishTurn(input, {
      replyText: ensureNonEmptyReply(
        post.replyText,
        "Thanks for your patience. Could you tell me what you're calling about?",
      ),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post.nextState,
    });
  }

  if (isNameCaptureTurn(fieldsBefore, conversationState, trimmedSpeech, {
    isFirstCallerTurn: input.isFirstCallerTurn,
  })) {
    const nameOutcome = processValidatedNameCaptureTurn({
      fields: fieldsBefore,
      speech: trimmedSpeech,
    });

    if (nameOutcome.status === "confirm" || nameOutcome.status === "repeat") {
      session = applyLocalSessionUpdate(session, {
        collectedFields: nameOutcome.fields as RealtimeFields,
        currentQuestion: nameOutcome.replyText,
      });

      persistTurnAsync(callSid, {
        collectedFields: nameOutcome.fields as RealtimeFields,
        currentQuestion: nameOutcome.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: nameOutcome.replyText,
      });

      return finishTurn(input, {
        replyText: ensureSingleIntakeQuestion(nameOutcome.replyText),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake",
      });
    }

    const confirmedFields = nameOutcome.fields as RealtimeFields;
    const filledCount = countNewlyFilledFields(fieldsBefore, confirmedFields);
    const post = buildPostIntakeReply(
      acknowledgmentPolicy,
      fieldsBefore,
      confirmedFields,
      trimmedSpeech,
      callerPhone,
      filledCount,
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
    });

    persistTurnAsync(callSid, {
      collectedFields: post.fields,
      currentQuestion: post.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post.replyText,
    });

    return finishTurn(input, {
      replyText: post.replyText,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post.nextState,
    });
  }

  let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, trimmedSpeech, callerPhone, {
    conversationState,
    isFirstCallerTurn: input.isFirstCallerTurn,
  });

  if (isTurnDiagnosticsEnabled()) {
    logTurnStateAfterMerge({
      fieldsAfter: updatedFields,
      conversationState,
    });
  }

  if (detectEmergency(trimmedSpeech) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true,
    };
  }

  if (
    updatedFields.name_needs_clarification &&
    resolvePendingQuestion(updatedFields, conversationState) === "caller_name"
  ) {
    const attempts = updatedFields.name_clarification_attempts ?? 0;

    if (attempts >= 3) {
      updatedFields = syncLegacyStringFields({
        ...updatedFields,
        caller_name_unavailable: true,
        name_needs_clarification: false,
      });

      const filledCount = countNewlyFilledFields(fieldsBefore, updatedFields);
      const post = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        updatedFields,
        trimmedSpeech,
        callerPhone,
        filledCount,
      );

      session = applyLocalSessionUpdate(session, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
      });

      persistTurnAsync(callSid, {
        collectedFields: post.fields,
        currentQuestion: post.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post.replyText,
      });

      return finishTurn(input, {
        replyText: post.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post.nextState,
      });
    }

    const reply = ensureSingleIntakeQuestion(
      buildNameClarificationPrompt(trimmedSpeech, { askToSpell: attempts >= 2 }),
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields,
      currentQuestion: reply,
    });

    persistTurnAsync(callSid, {
      collectedFields: updatedFields,
      currentQuestion: reply,
      callerSpeech: trimmedSpeech,
      assistantReply: reply,
    });

    return finishTurn(input, {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake",
    });
  }

  const filledCount = countNewlyFilledFields(fieldsBefore, updatedFields);
  const post = buildPostIntakeReply(
    acknowledgmentPolicy,
    fieldsBefore,
    updatedFields,
    trimmedSpeech,
    callerPhone,
    filledCount,
    {
      afterConfirmation: false,
      isFirstCallerTurn: input.isFirstCallerTurn,
      hasReceivedMeaningfulCallerTranscript: input.hasReceivedMeaningfulCallerTranscript,
    },
  );

  session = applyLocalSessionUpdate(session, {
    collectedFields: post.fields,
    currentQuestion: post.replyText,
  });

  persistTurnAsync(callSid, {
    collectedFields: post.fields,
    currentQuestion: post.replyText,
    callerSpeech: trimmedSpeech,
    assistantReply: post.replyText,
  });

  return finishTurn(input, {
    replyText: ensureNonEmptyReply(
      post.replyText,
      "Thanks for your patience. Could you repeat that last answer for me?",
    ),
    hangup: false,
    hangupAfterMark: false,
    session,
    nextConversationState: post.nextState,
  });
}

export function buildNameNoInputRetry(fields: RealtimeFields): string {
  if (isAwaitingNameConfirmation(fields)) {
    const pending = fields.name_pending_confirmation?.trim();
    if (pending) {
      return `I didn't catch that. ${buildNameConfirmationPrompt(pending)}`;
    }
  }

  if (fields.name_awaiting_repeat) {
    return `I didn't catch that. ${buildNameRepeatPrompt()}`;
  }

  return "I didn't catch that. What's your name?";
}
