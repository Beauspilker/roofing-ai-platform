import twilio from "twilio";
import {
  getNextMissingStage,
  getStageQuestion,
  OPENING_GREETING,
} from "@/lib/call-intake";
import {
  createTranscriptEntry,
  ensureCallSessionForTwilioCall,
  updateCallSession,
} from "@/lib/call-sessions";
import {
  appendSpeechGather,
  getTwilioCallContext,
  twimlResponse,
} from "@/lib/twilio/helpers";

export async function POST(request: Request) {
  const formData = await request.formData();
  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const message = OPENING_GREETING;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(message);

  if (callSid) {
    try {
      const session = await ensureCallSessionForTwilioCall({
        callSid,
        callerPhone,
        calledPhone,
      });

      if (session) {
        const nextStage = getNextMissingStage(session.collected_fields ?? {});

        await updateCallSession({
          callSid,
          currentQuestion:
            getStageQuestion(
              nextStage,
              session.collected_fields ?? {},
              callerPhone,
            ) ?? message,
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
