import twilio from "twilio";
import { processCallerTurn } from "@/lib/call-turn-processor";
import { generateConversationResponse } from "@/lib/ai/voice";
import {
  ensureCallSessionForTwilioCall,
} from "@/lib/call-sessions";
import {
  appendSpeechGather,
  getSpeechResult,
  getTwilioCallContext,
  twimlResponse,
} from "@/lib/twilio/helpers";
import { appendSpokenSay } from "@/lib/twilio/speech";
import { validateTwilioRequest } from "@/lib/twilio/signature";

function speak(twiml: twilio.twiml.VoiceResponse, text: string): void {
  appendSpokenSay(twiml, text);
}

export async function POST(request: Request) {
  const formData = await request.formData();

  if (!validateTwilioRequest(request, formData)) {
    return new Response("Forbidden", { status: 403 });
  }

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

  if (!session && !callSid && speechResult) {
    const reply = await generateConversationResponse(speechResult);
    speak(twiml, reply);
    appendSpeechGather(twiml, request, { attempt: 1 });
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

  speak(twiml, outcome.replyText);

  if (outcome.kind === "speak_hangup") {
    return twimlResponse(twiml);
  }

  appendSpeechGather(twiml, request, {
    attempt: speechResult ? 1 : attempt + 1,
    initial: isInitial,
  });

  return twimlResponse(twiml);
}
