import twilio from "twilio";
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
  ensureCallSessionForTwilioCall,
  getCallSessionBySid,
  updateCallSession,
} from "@/lib/call-sessions";
import { generateConversationResponse } from "@/lib/ai/voice";
import {
  appendSpeechGather,
  CALLER_GOODBYE,
  getSpeechResult,
  getTwilioCallContext,
  isConfirmationPhrase,
  isGoodbyePhrase,
  NO_INPUT_GOODBYE,
  NO_INPUT_FOLLOW_UP_PROMPT,
  OPENING_RETRY_PROMPT,
  twimlResponse,
} from "@/lib/twilio/helpers";

function getNoInputRetryPrompt(
  session: Awaited<ReturnType<typeof getCallSessionBySid>>,
  callerPhone: string,
  isInitial: boolean,
): string {
  if (!session) {
    return OPENING_RETRY_PROMPT;
  }

  const fields = session.collected_fields ?? {};

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
  fields: Parameters<typeof getStageQuestion>[1],
  callerPhone: string,
  session: NonNullable<Awaited<ReturnType<typeof getCallSessionBySid>>>,
  prefix: string,
): string {
  const stage = getNextMissingStage(fields ?? {});
  const question =
    getStageQuestion(stage, fields ?? {}, callerPhone) ??
    session.current_question ??
    "Let's keep going.";

  return buildCombinedResponse([prefix], question);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const speechResult = getSpeechResult(formData);
  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const { searchParams } = new URL(request.url);
  const attempt = Number.parseInt(searchParams.get("attempt") ?? "1", 10);
  const isInitial = searchParams.get("initial") === "1";

  const twiml = new twilio.twiml.VoiceResponse();
  let session = callSid
    ? await ensureCallSessionForTwilioCall({
        callSid,
        callerPhone,
        calledPhone,
      })
    : null;

  if (!speechResult) {
    if (callSid) {
      await updateCallSession({
        callSid,
        attemptCount: attempt,
      });
    }

    if (attempt >= 2) {
      if (callSid) {
        await completeCallSession(callSid, "failed");
      }

      twiml.say(NO_INPUT_GOODBYE);
      return twimlResponse(twiml);
    }

    twiml.say(getNoInputRetryPrompt(session, callerPhone, isInitial));
    appendSpeechGather(twiml, request, {
      attempt: attempt + 1,
      initial: isInitial,
    });
    return twimlResponse(twiml);
  }

  if (isGoodbyePhrase(speechResult)) {
    if (callSid) {
      await completeCallSession(callSid, "completed");
    }

    twiml.say(CALLER_GOODBYE);
    return twimlResponse(twiml);
  }

  if (!session || !callSid) {
    const reply = await generateConversationResponse(speechResult);
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
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
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
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
      twiml.say(reply);
      return twimlResponse(twiml);
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
      twiml.say(reply);
      appendSpeechGather(twiml, request, { attempt: 1 });
      return twimlResponse(twiml);
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
      twiml.say(reply);
      appendSpeechGather(twiml, request, { attempt: 1 });
      return twimlResponse(twiml);
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
      twiml.say(reply);
      appendSpeechGather(twiml, request, { attempt: 1 });
      return twimlResponse(twiml);
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
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
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
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
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
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
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

  session =
    (await updateCallSession({
      callSid,
      collectedFields: updatedFields,
      transcriptEntry: createTranscriptEntry("caller", speechResult),
      attemptCount: 1,
    })) ?? session;

  const nextStage = getNextMissingStage(updatedFields);

  if (nextStage === "wrap_up") {
    const summary = buildWrapUpSummary(updatedFields);

    await updateCallSession({
      callSid,
      collectedFields: {
        ...updatedFields,
        summary_delivered: true,
      },
      currentQuestion: getSummaryConfirmationPrompt(),
      transcriptEntry: createTranscriptEntry("assistant", summary),
    });

    twiml.say(summary);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
  }

  const reply = buildIntakeResponse(updatedFields, answeredStage, {
    callerPhone,
    turnIndex,
    fieldsBefore,
    callerAnswer: speechResult,
    priorPhrases,
  });

  await updateCallSession({
    callSid,
    currentQuestion: getStageQuestion(nextStage, updatedFields, callerPhone),
    transcriptEntry: createTranscriptEntry("assistant", reply),
  });

  twiml.say(reply);
  appendSpeechGather(twiml, request, {
    attempt: 1,
  });

  return twimlResponse(twiml);
}
