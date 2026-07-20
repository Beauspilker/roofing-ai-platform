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
import { isGoodbyePhrase } from "../../../../lib/twilio/voice-phrases.js";
import type { ConversationState } from "./conversation-state.js";
import {
  appendAnythingElseNotes,
  buildRealtimeAcknowledgement,
  getRealtimeNextMissingStage,
  getRealtimeStageQuestion,
  isRealtimeIntakeComplete,
  mergeRealtimeCallerAnswer,
  type RealtimeIntakeStage,
  toPersistedFields,
} from "./realtime-intake.js";
import {
  buildClosingMessage,
  buildRealtimeIntakeReply,
  buildStructuredSpokenSummary,
  buildSummaryWithConfirmation,
  ensureSingleIntakeQuestion,
  isAnythingElseDeclined,
  isSummaryConfirmed,
  isSummaryRejected,
  REALTIME_ANYTHING_ELSE_QUESTION,
  type RealtimeFields,
} from "./realtime-prompts.js";
import { applyCorrectionToStructuredField } from "./structured-intake.js";
import { logError } from "../logger.js";

export type RealtimeTurnOutcome = {
  replyText: string;
  hangup: boolean;
  hangupAfterMark: boolean;
  session: CallSession | null;
  nextConversationState: ConversationState;
};

export type ProcessRealtimeTurnInput = {
  session: CallSession | null;
  callSid: string;
  callerPhone: string;
  speechResult: string;
  conversationState: ConversationState;
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

function isNameCaptureTurn(fields: RealtimeFields): boolean {
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }

  return getRealtimeNextMissingStage(fields) === "full_name";
}

function buildSummaryReply(fields: RealtimeFields): string {
  return ensureSingleIntakeQuestion(buildSummaryWithConfirmation(fields));
}

export async function processRealtimeCallerTurn(
  input: ProcessRealtimeTurnInput,
): Promise<RealtimeTurnOutcome> {
  const { callSid, callerPhone, speechResult, conversationState } = input;
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

  if (isGoodbyePhrase(speechResult) && conversationState === "collecting_intake") {
    if (callSid) {
      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });
    }

    return {
      replyText: "Thanks for calling Beau's Roofing — have a great day.",
      hangup: true,
      hangupAfterMark: true,
      session,
      nextConversationState: "completed",
    };
  }

  if (!session || !callSid) {
    return {
      replyText: ensureSingleIntakeQuestion("What's going on with the roof?"),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake",
    };
  }

  const fieldsBefore = (session.collected_fields ?? {}) as RealtimeFields;

  if (conversationState === "awaiting_additional_notes") {
    let updatedFields = fieldsBefore;

    if (!isAnythingElseDeclined(trimmedSpeech)) {
      updatedFields = appendAnythingElseNotes(fieldsBefore, trimmedSpeech);
    }

    const reply = buildSummaryReply(updatedFields);
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

    return {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "presenting_summary",
    };
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
      const reply = buildClosingMessage();
      session = applyLocalSessionUpdate(session, {
        collectedFields: fieldsBefore,
        currentQuestion: null,
      });

      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });

      persistTurnAsync(callSid, {
        collectedFields: fieldsBefore,
        currentQuestion: null,
        callerSpeech: trimmedSpeech,
        assistantReply: reply,
      });

      return {
        replyText: ensureSingleIntakeQuestion(reply),
        hangup: true,
        hangupAfterMark: true,
        session,
        nextConversationState: "delivering_closing",
      };
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

      return {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_summary_confirmation",
      };
    }

    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "awaiting_summary_confirmation",
    };
  }

  if (input.isFirstCallerTurn) {
    let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, trimmedSpeech, callerPhone);

    if (detectEmergency(trimmedSpeech) && !updatedFields.emergency_acknowledged) {
      updatedFields = {
        ...updatedFields,
        urgency: updatedFields.urgency ?? "emergency",
        emergency_acknowledged: true,
      };
    }

    if (isRealtimeIntakeComplete(updatedFields)) {
      session = applyLocalSessionUpdate(session, {
        collectedFields: updatedFields,
        currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
      });

      persistTurnAsync(callSid, {
        collectedFields: updatedFields,
        currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
        callerSpeech: trimmedSpeech,
        assistantReply: REALTIME_ANYTHING_ELSE_QUESTION,
      });

      return {
        replyText: ensureSingleIntakeQuestion(REALTIME_ANYTHING_ELSE_QUESTION),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_additional_notes",
      };
    }

    const nextStage = getRealtimeNextMissingStage(updatedFields);
    const reply = buildRealtimeIntakeReply(
      "Got it.",
      getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields,
      currentQuestion: getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
    });

    persistTurnAsync(callSid, {
      collectedFields: updatedFields,
      currentQuestion: getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
      callerSpeech: trimmedSpeech,
      assistantReply: reply,
    });

    return {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake",
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

      return {
        replyText: ensureSingleIntakeQuestion(nameOutcome.replyText),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake",
      };
    }

    const confirmedFields = nameOutcome.fields as RealtimeFields;
    const nextStage = getRealtimeNextMissingStage(confirmedFields);

    if (nextStage === "wrap_up") {
      session = applyLocalSessionUpdate(session, {
        collectedFields: confirmedFields,
        currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
      });

      persistTurnAsync(callSid, {
        collectedFields: confirmedFields,
        currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
        callerSpeech: trimmedSpeech,
        assistantReply: REALTIME_ANYTHING_ELSE_QUESTION,
      });

      return {
        replyText: ensureSingleIntakeQuestion(REALTIME_ANYTHING_ELSE_QUESTION),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_additional_notes",
      };
    }

    const reply = buildRealtimeIntakeReply(
      "Thanks.",
      getRealtimeStageQuestion(nextStage, confirmedFields, callerPhone),
    );

    session = applyLocalSessionUpdate(session, {
      collectedFields: confirmedFields,
      currentQuestion: getRealtimeStageQuestion(nextStage, confirmedFields, callerPhone),
    });

    persistTurnAsync(callSid, {
      collectedFields: confirmedFields,
      currentQuestion: getRealtimeStageQuestion(nextStage, confirmedFields, callerPhone),
      callerSpeech: trimmedSpeech,
      assistantReply: reply,
    });

    return {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake",
    };
  }

  const answeredStage = getRealtimeNextMissingStage(fieldsBefore);
  let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, trimmedSpeech, callerPhone);

  if (detectEmergency(trimmedSpeech) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true,
    };
  }

  if (isRealtimeIntakeComplete(updatedFields)) {
    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields,
      currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
    });

    persistTurnAsync(callSid, {
      collectedFields: updatedFields,
      currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
      callerSpeech: trimmedSpeech,
      assistantReply: REALTIME_ANYTHING_ELSE_QUESTION,
    });

    return {
      replyText: REALTIME_ANYTHING_ELSE_QUESTION,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "awaiting_additional_notes",
    };
  }

  const nextStage = getRealtimeNextMissingStage(updatedFields);
  const ack =
    answeredStage !== "wrap_up"
      ? buildRealtimeAcknowledgement(
          answeredStage as RealtimeIntakeStage,
          trimmedSpeech,
          updatedFields,
        )
      : null;
  const reply = buildRealtimeIntakeReply(
    ack,
    getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
  );

  session = applyLocalSessionUpdate(session, {
    collectedFields: updatedFields,
    currentQuestion: getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
  });

  persistTurnAsync(callSid, {
    collectedFields: updatedFields,
    currentQuestion: getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
    callerSpeech: trimmedSpeech,
    assistantReply: reply,
  });

  return {
    replyText: ensureSingleIntakeQuestion(reply),
    hangup: false,
    hangupAfterMark: false,
    session,
    nextConversationState: "collecting_intake",
  };
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
