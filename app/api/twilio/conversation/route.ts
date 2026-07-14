import twilio from "twilio";
import { generateConversationResponse } from "@/lib/ai/voice";
import {
  applyCallerAnswer,
  buildConversationMemoryContext,
  completeCallSession,
  createTranscriptEntry,
  getCallSessionBySid,
  getCompanyIdByCalledPhone,
  getCurrentStage,
  getOrCreateCallSession,
  getStageQuestion,
  updateCallSession,
} from "@/lib/call-sessions";
import { createServiceClient } from "@/lib/supabase/service";
import {
  appendSpeechGather,
  CALLER_GOODBYE,
  getSpeechResult,
  getTwilioCallContext,
  isGoodbyePhrase,
  NO_INPUT_FOLLOW_UP_PROMPT,
  NO_INPUT_GOODBYE,
  NO_INPUT_RETRY_PROMPT,
  twimlResponse,
} from "@/lib/twilio/helpers";

async function ensureCallSession(
  callSid: string,
  callerPhone: string,
  calledPhone: string,
) {
  const existingSession = await getCallSessionBySid(callSid);

  if (existingSession) {
    return existingSession;
  }

  const supabase = createServiceClient();

  if (!supabase) {
    return null;
  }

  const companyId = await getCompanyIdByCalledPhone(supabase, calledPhone);

  if (!companyId) {
    return null;
  }

  return getOrCreateCallSession({
    callSid,
    companyId,
    callerPhone,
    calledPhone,
  });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const speechResult = getSpeechResult(formData);
  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const { searchParams } = new URL(request.url);
  const attempt = Number.parseInt(searchParams.get("attempt") ?? "1", 10);
  const isInitial = searchParams.get("initial") === "1";

  const twiml = new twilio.twiml.VoiceResponse();

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

    twiml.say(isInitial ? NO_INPUT_RETRY_PROMPT : NO_INPUT_FOLLOW_UP_PROMPT);
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

  let session = callSid
    ? await ensureCallSession(callSid, callerPhone, calledPhone)
    : null;

  let memory = session ? buildConversationMemoryContext(session) : undefined;

  if (session && callSid) {
    const answerStage = getCurrentStage(session.collected_fields ?? {});
    const updatedFields = applyCallerAnswer(
      session.collected_fields ?? {},
      answerStage,
      speechResult,
    );

    session =
      (await updateCallSession({
        callSid,
        collectedFields: updatedFields,
        transcriptEntry: createTranscriptEntry("caller", speechResult),
        attemptCount: 1,
      })) ?? session;

    memory = buildConversationMemoryContext(session);
  }

  const reply = await generateConversationResponse(speechResult, memory);
  twiml.say(reply);

  if (session && callSid) {
    const nextStage = getCurrentStage(session.collected_fields ?? {});

    await updateCallSession({
      callSid,
      currentQuestion: getStageQuestion(nextStage),
      transcriptEntry: createTranscriptEntry("assistant", reply),
    });
  }

  appendSpeechGather(twiml, request, {
    attempt: 1,
  });

  return twimlResponse(twiml);
}
