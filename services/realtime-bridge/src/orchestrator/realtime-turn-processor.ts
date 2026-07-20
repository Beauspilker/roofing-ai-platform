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
  type RealtimeFields,
} from "./realtime-prompts.js";
import { applyCorrectionToStructuredField, syncLegacyStringFields } from "./structured-intake.js";
import { logError } from "../logger.js";

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
    structuredStateUpdated: true,
  };
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

function buildPostIntakeReply(
  policy: AcknowledgmentPolicy,
  fieldsBefore: RealtimeFields,
  updatedFields: RealtimeFields,
  trimmedSpeech: string,
  callerPhone: string,
  filledCount: number,
  options: { afterConfirmation?: boolean } = {},
): { replyText: string; fields: RealtimeFields; nextState: ConversationState } {
  if (needsCallbackReadback(updatedFields)) {
    const reply = buildCallbackConfirmationReply(updatedFields);
    return {
      replyText: reply,
      fields: updatedFields,
      nextState: "awaiting_callback_confirmation",
    };
  }

  if (needsAddressReadback(updatedFields)) {
    const reply = buildAddressConfirmationReply(updatedFields);
    return {
      replyText: reply,
      fields: updatedFields,
      nextState: "awaiting_address_confirmation",
    };
  }

  if (needsScheduleClarification(updatedFields)) {
    const prompt =
      updatedFields.schedule_clarification_prompt?.trim() ||
      "What time works best?";
    return {
      replyText: ensureSingleIntakeQuestion(prompt),
      fields: updatedFields,
      nextState: "awaiting_schedule_clarification",
    };
  }

  if (needsScheduleConfirmation(updatedFields)) {
    const reply = buildScheduleConfirmationReply(updatedFields);
    return {
      replyText: reply,
      fields: updatedFields,
      nextState: "awaiting_schedule_confirmation",
    };
  }

  const missing = getMissingRequiredFields(updatedFields);

  if (missing.length === 0) {
    return {
      replyText: ensureSingleIntakeQuestion(REALTIME_ANYTHING_ELSE_QUESTION),
      fields: updatedFields,
      nextState: "awaiting_additional_notes",
    };
  }

  return {
    replyText: ensureSingleIntakeQuestion(
      buildIntakeReply(
        policy,
        updatedFields,
        trimmedSpeech,
        callerPhone,
        filledCount,
        options.afterConfirmation === true,
      ),
    ),
    fields: updatedFields,
    nextState: "collecting_intake",
  };
}

function isNameCaptureTurn(fields: RealtimeFields): boolean {
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }

  return getRealtimeNextMissingStage(fields) === "full_name";
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

  const fieldsBefore = normalizeRealtimeFields(
    (session.collected_fields ?? {}) as RealtimeFields,
  );

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
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_clarification",
      };
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
      replyText: post.replyText,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post.nextState,
    });
  }

  if (conversationState === "awaiting_schedule_confirmation") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_confirmation",
      };
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
        : buildScheduleConfirmationReply(nextFields);

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
    if (getMissingRequiredFields(fieldsBefore).length > 0) {
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

    let updatedFields = fieldsBefore;

    if (!isAnythingElseDeclined(trimmedSpeech)) {
      updatedFields = appendAnythingElseNotes(fieldsBefore, trimmedSpeech);
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

  if (isNameCaptureTurn(fieldsBefore)) {
    const nameOutcome = processNameCaptureTurn({
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

  let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, trimmedSpeech, callerPhone);

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
