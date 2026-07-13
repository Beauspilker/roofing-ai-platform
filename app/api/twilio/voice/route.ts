import twilio from "twilio";
import { generateVoiceResponse } from "@/lib/ai/voice";
import {
  appendSpeechGather,
  ROOF_QUESTION,
  twimlResponse,
} from "@/lib/twilio/helpers";

export async function POST(request: Request) {
  const message = await generateVoiceResponse();
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(message);

  appendSpeechGather(twiml, request, {
    attempt: 1,
    initial: true,
    prompt: ROOF_QUESTION,
  });

  return twimlResponse(twiml);
}
