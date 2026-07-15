import {
  buildNameConfirmationPrompt,
  buildNameRepeatPrompt,
  isAwaitingNameConfirmation,
  parseSpeechConfidence,
  processNameCaptureTurn,
} from "@/lib/call-name-capture";
import {
  buildConfirmedGoodbye,
  buildIntakeResponse,
  buildWrapUpSummary,
  clearSummaryEditState,
  getNextMissingStage,
  getRecentAssistantPhrases,
  getStageQuestion,
  isAwaitingSummaryConfirmation,
  isAwaitingSummaryEditValue,
  mergeCallerAnswer,
  type CollectedFields,
  type ConversationStage,
} from "@/lib/call-intake";
import {
  buildCombinedResponse,
  buildFaqResponse,
  buildInterruptionResume,
  buildSmallTalkResponse,
  detectEmergency,
  detectFaqTopic,
  detectSmallTalk,
  hasCorrectionIntent,
  isInterruptionPause,
  isLikelyFaqOnly,
  processSummaryEdit,
} from "@/lib/call-intelligence";
import {
  buildSummaryEditValuePrompt,
  buildSummaryFieldsUpdateReply,
  getPostEditConfirmationPrompt,
  getSummaryConfirmationPrompt,
  isPostEditAffirmation,
  isSummaryChangeDeclined,
  type SummaryFieldKey,
} from "@/lib/call-summary";
import {
  completeCallSession,
  createTranscriptEntry,
  type CallSession,
  updateCallSession,
} from "@/lib/call-sessions";
import {
  CALLER_GOODBYE,
  MAX_SPEECH_NO_INPUT_ATTEMPTS,
  NO_INPUT_FOLLOW_UP_PROMPT,
  NO_INPUT_GOODBYE,
  OPENING_RETRY_PROMPT,
  isConfirmationPhrase,
  isGoodbyePhrase,
} from "@/lib/twilio/helpers";

export type TurnOutcome =
  | {
      kind: "speak_continue";
      replyText: string;
      session: CallSession | null;
    }
  | {
      kind: "speak_hangup";
      replyText: string;
      session: CallSession | null;
      completionStatus: "completed" | "failed";
    };

export type ProcessCallerTurnInput = {
  session: CallSession | null;
  callSid: string;
  callerPhone: string;
  speechResult: string;
  speechConfidence?: string | null;
  attempt: number;
  isInitial: boolean;
};

function getEffectiveGatherStage(
  fields: CollectedFields,
): ConversationStage | "wrap_up" {
  if (isAwaitingNameConfirmation(fields)) {
    return "full_name";
  }

  return getNextMissingStage(fields);
}

function isNameCaptureTurn(fields: CollectedFields): boolean {
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }

  return getNextMissingStage(fields) === "full_name";
}

async function persistTurn(
  callSid: string,
  input: {
    collectedFields?: CollectedFields;
    currentQuestion?: string | null;
    callerSpeech: string;
    assistantReply: string;
    attemptCount?: number;
  },
): Promise<CallSession | null> {
  const session =
    (await updateCallSession({
      callSid,
      collectedFields: input.collectedFields,
      currentQuestion: input.currentQuestion ?? null,
      transcriptEntry: createTranscriptEntry("caller", input.callerSpeech),
      attemptCount: input.attemptCount,
    })) ?? null;

  await updateCallSession({
    callSid,
    transcriptEntry: createTranscriptEntry("assistant", input.assistantReply),
  });

  return session;
}

function getNoInputRetryPrompt(
  session: CallSession | null,
  callerPhone: string,
  isInitial: boolean,
): string {
  if (!session) {
    return OPENING_RETRY_PROMPT;
  }

  const fields = session.collected_fields ?? {};

  if (isAwaitingNameConfirmation(fields)) {
    const pending = fields.name_pending_confirmation?.trim();

    if (pending) {
      return `I didn't catch that. ${buildNameConfirmationPrompt(pending)}`;
    }
  }

  if (fields.name_awaiting_repeat) {
    return `I didn't catch that. ${buildNameRepeatPrompt()}`;
  }

  if (isAwaitingSummaryConfirmation(fields)) {
    if (isAwaitingSummaryEditValue(fields)) {
      return `I didn't catch that. ${buildSummaryEditValuePrompt(
        fields.summary_edit_target as SummaryFieldKey,
      )}`;
    }

    return `I didn't catch that. ${getSummaryConfirmationPrompt()}`;
  }

  const nextStage = getNextMissingStage(fields);

  if (isInitial && nextStage === "problem") {
    return OPENING_RETRY_PROMPT;
  }

  const question =
    getStageQuestion(nextStage, fields, callerPhone) ?? session.current_question;

  if (question) {
    return `I didn't catch that. ${question}`;
  }

  return NO_INPUT_FOLLOW_UP_PROMPT;
}

function buildResumeReply(
  fields: CollectedFields,
  callerPhone: string,
  session: CallSession,
  prefix: string,
): string {
  const stage = getNextMissingStage(fields ?? {});
  const question =
    getStageQuestion(stage, fields ?? {}, callerPhone) ??
    session.current_question ??
    "Let's keep going.";

  return buildCombinedResponse([prefix], question);
}

export async function processCallerTurn(
  input: ProcessCallerTurnInput,
): Promise<TurnOutcome & {
  nameConfirmationRequested?: boolean;
  nameCorrected?: boolean;
  gatherStage?: ConversationStage | "wrap_up" | null;
}> {
  const {
    callSid,
    callerPhone,
    speechResult,
    speechConfidence,
    attempt,
    isInitial,
  } = input;
  let session = input.session;
  let nameConfirmationRequested = false;
  let nameCorrected = false;

  if (!speechResult.trim()) {
    if (callSid) {
      await updateCallSession({
        callSid,
        attemptCount: attempt,
      });
    }

    if (attempt >= MAX_SPEECH_NO_INPUT_ATTEMPTS) {
      if (callSid) {
        await completeCallSession(callSid, "failed");
      }

      return {
        kind: "speak_hangup",
        replyText: NO_INPUT_GOODBYE,
        session,
        completionStatus: "failed",
      };
    }

    return {
      kind: "speak_continue",
      replyText: getNoInputRetryPrompt(session, callerPhone, isInitial),
      session,
      gatherStage: session
        ? getEffectiveGatherStage(session.collected_fields ?? {})
        : null,
    };
  }

  if (isGoodbyePhrase(speechResult)) {
    if (callSid) {
      await completeCallSession(callSid, "completed");
    }

    return {
      kind: "speak_hangup",
      replyText: CALLER_GOODBYE,
      session,
      completionStatus: "completed",
    };
  }

  if (!session || !callSid) {
    return {
      kind: "speak_continue",
      replyText:
        "I'm having a little trouble on my end. What's going on with the roof?",
      session,
    };
  }

  const fieldsBefore = session.collected_fields ?? {};
  const priorPhrases = getRecentAssistantPhrases(session.transcript);
  const turnIndex = session.transcript?.length ?? 0;

  if (isInterruptionPause(speechResult)) {
    const reply = buildInterruptionResume(session.current_question);

    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult),
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });

    return { kind: "speak_continue", replyText: reply, session };
  }

  if (isAwaitingSummaryConfirmation(fieldsBefore)) {
    const awaitingEditValue = isAwaitingSummaryEditValue(fieldsBefore);

    if (
      !awaitingEditValue &&
      (isConfirmationPhrase(speechResult) || isPostEditAffirmation(speechResult)) &&
      !hasCorrectionIntent(speechResult)
    ) {
      const reply = buildConfirmedGoodbye();

      await updateCallSession({
        callSid,
        collectedFields: clearSummaryEditState({
          ...fieldsBefore,
          summary_confirmed: true,
        }),
        transcriptEntry: createTranscriptEntry("caller", speechResult),
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply),
      });
      await completeCallSession(callSid, "completed");

      return {
        kind: "speak_hangup",
        replyText: reply,
        session,
        completionStatus: "completed",
      };
    }

    const editOutcome = processSummaryEdit(
      fieldsBefore,
      speechResult,
      callerPhone,
    );

    if (editOutcome.status === "updated") {
      const updatedFields = clearSummaryEditState(editOutcome.fields);
      const reply = buildSummaryFieldsUpdateReply(
        updatedFields,
        editOutcome.updatedFields,
      );

      await updateCallSession({
        callSid,
        collectedFields: updatedFields,
        currentQuestion: getPostEditConfirmationPrompt(),
        transcriptEntry: createTranscriptEntry("caller", speechResult),
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply),
      });

      return { kind: "speak_continue", replyText: reply, session };
    }

    if (editOutcome.status === "awaiting_value") {
      const reply = buildSummaryEditValuePrompt(editOutcome.target);

      await updateCallSession({
        callSid,
        collectedFields: editOutcome.fields,
        currentQuestion: reply,
        transcriptEntry: createTranscriptEntry("caller", speechResult),
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply),
      });

      return { kind: "speak_continue", replyText: reply, session };
    }

    if (!awaitingEditValue && isSummaryChangeDeclined(speechResult)) {
      const reply = "What would you like to change?";

      await updateCallSession({
        callSid,
        collectedFields: clearSummaryEditState(fieldsBefore),
        currentQuestion: reply,
        transcriptEntry: createTranscriptEntry("caller", speechResult),
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply),
      });

      return { kind: "speak_continue", replyText: reply, session };
    }

    const reply = awaitingEditValue
      ? buildSummaryEditValuePrompt(
          fieldsBefore.summary_edit_target as SummaryFieldKey,
        )
      : getSummaryConfirmationPrompt();

    await updateCallSession({
      callSid,
      currentQuestion: reply,
      transcriptEntry: createTranscriptEntry("caller", speechResult),
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });

    return { kind: "speak_continue", replyText: reply, session };
  }

  const faqTopic = detectFaqTopic(speechResult);

  if (faqTopic && isLikelyFaqOnly(speechResult)) {
    const reply = buildResumeReply(
      fieldsBefore,
      callerPhone,
      session,
      buildFaqResponse(faqTopic),
    );

    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult),
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });

    return { kind: "speak_continue", replyText: reply, session };
  }

  if (detectSmallTalk(speechResult)) {
    const reply = buildResumeReply(
      fieldsBefore,
      callerPhone,
      session,
      buildSmallTalkResponse(speechResult),
    );

    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult),
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });

    return { kind: "speak_continue", replyText: reply, session };
  }

  if (isNameCaptureTurn(fieldsBefore)) {
    const nameOutcome = processNameCaptureTurn({
      fields: fieldsBefore,
      speech: speechResult,
      confidence: parseSpeechConfidence(speechConfidence),
    });

    nameConfirmationRequested = nameOutcome.nameConfirmationRequested;
    nameCorrected = nameOutcome.nameCorrected;

    if (nameOutcome.status === "confirm" || nameOutcome.status === "repeat") {
      session =
        (await persistTurn(callSid, {
          collectedFields: nameOutcome.fields,
          currentQuestion: nameOutcome.replyText,
          callerSpeech: speechResult,
          assistantReply: nameOutcome.replyText,
          attemptCount: 1,
        })) ?? session;

      return {
        kind: "speak_continue",
        replyText: nameOutcome.replyText,
        session,
        nameConfirmationRequested,
        nameCorrected,
        gatherStage: "full_name",
      };
    }

    const confirmedFields = nameOutcome.fields;
    const answeredStage = "full_name" as const;

    const nextStage = getNextMissingStage(confirmedFields);

    if (nextStage === "wrap_up") {
      const summary = buildWrapUpSummary(confirmedFields);

      session =
        (await persistTurn(callSid, {
          collectedFields: {
            ...confirmedFields,
            summary_delivered: true,
          },
          currentQuestion: getSummaryConfirmationPrompt(),
          callerSpeech: speechResult,
          assistantReply: summary,
        })) ?? session;

      return {
        kind: "speak_continue",
        replyText: summary,
        session,
        nameConfirmationRequested,
        nameCorrected,
        gatherStage: "wrap_up",
      };
    }

    const reply = buildIntakeResponse(confirmedFields, answeredStage, {
      callerPhone,
      turnIndex,
      fieldsBefore,
      callerAnswer: speechResult,
      priorPhrases,
    });

    session =
      (await persistTurn(callSid, {
        collectedFields: confirmedFields,
        currentQuestion: getStageQuestion(nextStage, confirmedFields, callerPhone),
        callerSpeech: speechResult,
        assistantReply: reply,
      })) ?? session;

    return {
      kind: "speak_continue",
      replyText: reply,
      session,
      nameConfirmationRequested,
      nameCorrected,
      gatherStage: nextStage,
    };
  }

  const answeredStage = getNextMissingStage(fieldsBefore);
  let updatedFields = mergeCallerAnswer(
    fieldsBefore,
    speechResult,
    callerPhone,
  );

  if (detectEmergency(speechResult) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true,
    };
  }

  const nextStage = getNextMissingStage(updatedFields);

  if (nextStage === "wrap_up") {
    const summary = buildWrapUpSummary(updatedFields);

    session =
      (await persistTurn(callSid, {
        collectedFields: {
          ...updatedFields,
          summary_delivered: true,
        },
        currentQuestion: getSummaryConfirmationPrompt(),
        callerSpeech: speechResult,
        assistantReply: summary,
        attemptCount: 1,
      })) ?? session;

    return {
      kind: "speak_continue",
      replyText: summary,
      session,
      gatherStage: "wrap_up",
    };
  }

  const reply = buildIntakeResponse(updatedFields, answeredStage, {
    callerPhone,
    turnIndex,
    fieldsBefore,
    callerAnswer: speechResult,
    priorPhrases,
  });

  session =
    (await persistTurn(callSid, {
      collectedFields: updatedFields,
      currentQuestion: getStageQuestion(nextStage, updatedFields, callerPhone),
      callerSpeech: speechResult,
      assistantReply: reply,
      attemptCount: 1,
    })) ?? session;

  return {
    kind: "speak_continue",
    replyText: reply,
    session,
    gatherStage: nextStage,
  };
}
