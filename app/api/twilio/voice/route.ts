import { NextResponse } from "next/server";
import twilio from "twilio";

const GREETING =
  "Thank you for calling. This is the Roofing AI assistant. We are currently setting up our AI receptionist.";

export async function POST() {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(GREETING);

  return new NextResponse(twiml.toString(), {
    status: 200,
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
