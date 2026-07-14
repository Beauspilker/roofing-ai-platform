import twilio from "twilio";
import {
  buildIntakeResponse,
  buildWrapUpSummary,
  getNextMissingStage,
  getStageQuestion,
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
  isGoodbyePhrase,
  NO_INPUT_GOODBYE,
  NO_INPUT_FOLLOW_UP_PROMPT,
  twimlResponse,
} from "@/lib/twilio/helpers";

function getNoInputRetryPrompt(
  session: Awaited<ReturnType<typeof getCallSessionBySid>>,
  callerPhone: string,
): string {
  if (!session) {
    return "I didn't catch that. Please tell me what is going on with your roof today.";
  }

  const nextStage = getNextMissingStage(session.collected_fields ?? {});
  const question =
    getStageQuestion(nextStage, session.collected_fields ?? {}, callerPhone) ??
    session.current_question;

  if (question) {
    return `I didn't catch that. ${question}`;
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

    twiml.say(getNoInputRetryPrompt(session, callerPhone));
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
      currentQuestion: null,
      transcriptEntry: createTranscriptEntry("assistant", summary),
    });
    await completeCallSession(callSid, "completed");

    twiml.say(summary);
    return twimlResponse(twiml);
  }

  const reply = buildIntakeResponse(updatedFields, answeredStage, {
    callerPhone,
    turnIndex,
    fieldsBefore,
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
