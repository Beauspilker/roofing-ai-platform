import twilio from "twilio";
import { getNextMissingStage } from "@/lib/call-intake";
import { processCallerTurn } from "@/lib/call-turn-processor";
import { generateConversationResponse } from "@/lib/ai/voice";
import {
  ensureCallSessionForTwilioCall,
} from "@/lib/call-sessions";
import {
  appendSpeechGather,
  getSpeechConfidence,
  getSpeechResult,
  getTwilioCallContext,
  logSpeechGatherTurn,
  twimlResponse,
} from "@/lib/twilio/helpers";
import { appendSpokenSay } from "@/lib/twilio/speech";
import { validateTwilioRequest } from "@/lib/twilio/signature";

export async function POST(request: Request) {
  const formData = await request.formData();

  if (!validateTwilioRequest(request, formData)) {
    return new Response("Forbidden", { status: 403 });
  }

  const speechResult = getSpeechResult(formData);
  const speechConfidence = getSpeechConfidence(formData);
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

  const gatherStage = session
    ? getNextMissingStage(session.collected_fields ?? {})
    : null;

  logSpeechGatherTurn({
    callSid,
    attempt,
    isInitial,
    hasSpeechResult: speechResult.length > 0,
    confidence: speechConfidence,
    stage: gatherStage,
    outcome: speechResult.length > 0 ? "received" : "empty",
  });

  if (!session && !callSid && speechResult) {
    const reply = await generateConversationResponse(speechResult);
    appendSpeechGather(twiml, request, { attempt: 1, prompt: reply });
    return twimlResponse(twiml);
  }

  const outcome = await processCallerTurn({
    session,
    callSid,
    callerPhone,
    speechResult,
    attempt,
    isInitial,
  });

  session = outcome.session;

  logSpeechGatherTurn({
    callSid,
    attempt,
    isInitial,
    hasSpeechResult: speechResult.length > 0,
    confidence: speechConfidence,
    stage: gatherStage,
    outcome: outcome.kind === "speak_hangup" ? "hangup" : "continue",
  });

  if (outcome.kind === "speak_hangup") {
    appendSpokenSay(twiml, outcome.replyText);
    return twimlResponse(twiml);
  }

  appendSpeechGather(twiml, request, {
    attempt: speechResult ? 1 : attempt + 1,
    initial: isInitial,
    prompt: outcome.replyText,
  });

  return twimlResponse(twiml);
}
