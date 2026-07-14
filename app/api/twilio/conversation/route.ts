import twilio from "twilio";
import {
  buildConfirmedGoodbye,
  buildIntakeResponse,
  buildWrapUpSummary,
  getNextMissingStage,
  getRecentAssistantPhrases,
  getStageQuestion,
  isAwaitingSummaryConfirmation,
  mergeCallerAnswer,
} from "@/lib/call-intake";
import {
  applyTargetedCorrection,
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
  isSummaryFinalConfirmation,
} from "@/lib/call-intelligence";
import { buildSummaryFieldUpdateReply, getSummaryConfirmationPrompt, isSummaryDataField } from "@/lib/call-summary";
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
    return fields.summary_editing
      ? "I didn't catch that. Anything else you'd like to change?"
      : `I didn't catch that. ${getSummaryConfirmationPrompt()}`;
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
    if (
      isConfirmationPhrase(speechResult) &&
      !hasCorrectionIntent(speechResult)
    ) {
      const reply = buildConfirmedGoodbye();
      await updateCallSession({
        callSid,
        collectedFields: { ...fieldsBefore, summary_confirmed: true },
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

    if (fieldsBefore.summary_editing && isSummaryFinalConfirmation(speechResult)) {
      const reply = buildConfirmedGoodbye();
      await updateCallSession({
        callSid,
        collectedFields: { ...fieldsBefore, summary_confirmed: true },
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

    const correction = applyTargetedCorrection(
      fieldsBefore,
      speechResult,
      "wrap_up",
      callerPhone,
    );

    if (correction.updated || hasCorrectionIntent(speechResult)) {
      const updatedFields = correction.updated
        ? (correction.fields as typeof fieldsBefore)
        : fieldsBefore;
      const reply =
        correction.updated &&
        correction.field &&
        isSummaryDataField(correction.field)
          ? buildSummaryFieldUpdateReply(correction.field, updatedFields)
          : "Absolutely. I've updated that. Everything else stays the same. Anything else you'd like to change?";

      await updateCallSession({
        callSid,
        collectedFields: {
          ...updatedFields,
          summary_editing: true,
        },
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

    const reply = fieldsBefore.summary_editing
      ? "Anything else you'd like to change?"
      : getSummaryConfirmationPrompt();

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
