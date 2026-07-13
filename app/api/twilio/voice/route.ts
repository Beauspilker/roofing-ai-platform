import { NextResponse } from "next/server";
import twilio from "twilio";
import { generateVoiceResponse } from "@/lib/ai/voice";

export async function POST() {
  const message = await generateVoiceResponse();
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(message);

  return new NextResponse(twiml.toString(), {
    status: 200,
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
