import twilio from "twilio";
import { OPENING_GREETING } from "@/lib/call-intake";
import {
  createTranscriptEntry,
  ensureCallSessionForTwilioCall,
  updateCallSession,
} from "@/lib/call-sessions";
import {
  appendSpeechGather,
  getTwilioCallContext,
  OPENING_QUESTION,
  twimlResponse,
} from "@/lib/twilio/helpers";
import { appendSpokenSay } from "@/lib/twilio/speech";

export async function POST(request: Request) {
  const formData = await request.formData();
  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const message = OPENING_GREETING;
  const twiml = new twilio.twiml.VoiceResponse();
  appendSpokenSay(twiml, message);

  if (callSid) {
    try {
      const session = await ensureCallSessionForTwilioCall({
        callSid,
        callerPhone,
        calledPhone,
      });

      if (session) {
        await updateCallSession({
          callSid,
          currentQuestion: OPENING_QUESTION,
          transcriptEntry: createTranscriptEntry("assistant", message),
        });
      }
    } catch (error) {
      console.error("Failed to initialize call session:", error);
    }
  }

  appendSpeechGather(twiml, request, {
    attempt: 1,
    initial: true,
  });

  return twimlResponse(twiml);
}
