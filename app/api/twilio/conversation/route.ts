import twilio from "twilio";
import { generateConversationResponse } from "@/lib/ai/voice";
import {
  appendSpeechGather,
  CALLER_GOODBYE,
  getSpeechResult,
  isGoodbyePhrase,
  NO_INPUT_FOLLOW_UP_PROMPT,
  NO_INPUT_GOODBYE,
  NO_INPUT_RETRY_PROMPT,
  twimlResponse,
} from "@/lib/twilio/helpers";

export async function POST(request: Request) {
  const formData = await request.formData();
  const speechResult = getSpeechResult(formData);
  const { searchParams } = new URL(request.url);
  const attempt = Number.parseInt(searchParams.get("attempt") ?? "1", 10);
  const isInitial = searchParams.get("initial") === "1";

  const twiml = new twilio.twiml.VoiceResponse();

  if (!speechResult) {
    if (attempt >= 2) {
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
    twiml.say(CALLER_GOODBYE);
    return twimlResponse(twiml);
  }

  const reply = await generateConversationResponse(speechResult);
  twiml.say(reply);

  appendSpeechGather(twiml, request, {
    attempt: 1,
  });

  return twimlResponse(twiml);
}
