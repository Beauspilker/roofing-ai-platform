import twilio from "twilio";
import {
  buildConfirmedGoodbye,
  buildCorrectionGoodbye,
  buildIntakeResponse,
  buildWrapUpSummary,
  getNextMissingStage,
  getStageQuestion,
  isAwaitingSummaryConfirmation,
  mergeCallerAnswer,
} from "@/lib/call-intake";
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
  isCorrectionPhrase,
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
    return "I didn't catch that. Does all of that sound correct?";
  }

  const nextStage = getNextMissingStage(fields);
  const question =
    getStageQuestion(nextStage, fields, callerPhone) ?? session.current_question;

  if (question) {
    return isInitial && nextStage === "problem"
      ? OPENING_RETRY_PROMPT
      : `I didn't catch that. ${question}`;
  }

  return NO_INPUT_FOLLOW_UP_PROMPT;
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

  if (isAwaitingSummaryConfirmation(fieldsBefore)) {
    let reply: string;
    let confirmed = false;

    if (isConfirmationPhrase(speechResult)) {
      reply = buildConfirmedGoodbye();
      confirmed = true;
    } else if (isCorrectionPhrase(speechResult)) {
      reply = buildCorrectionGoodbye();
      confirmed = true;
    } else {
      reply = "Does all of that sound correct?";
    }

    await updateCallSession({
      callSid,
      collectedFields: {
        ...fieldsBefore,
        summary_confirmed: confirmed,
      },
      transcriptEntry: createTranscriptEntry("caller", speechResult),
    });

    if (confirmed) {
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply),
      });
      await completeCallSession(callSid, "completed");
      twiml.say(reply);
      return twimlResponse(twiml);
    }

    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });
    twiml.say(reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
    return twimlResponse(twiml);
  }

  const answeredStage = getNextMissingStage(fieldsBefore);
  const updatedFields = mergeCallerAnswer(
    fieldsBefore,
    speechResult,
    callerPhone,
  );
  const turnIndex = (session.transcript?.length ?? 0) + 1;

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
      currentQuestion: "Does all of that sound correct?",
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
