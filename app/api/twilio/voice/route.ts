import twilio from "twilio";
import { generateVoiceResponse } from "@/lib/ai/voice";
import { getNextMissingStage, getStageQuestion } from "@/lib/call-intake";
import {
  createTranscriptEntry,
  ensureCallSessionForTwilioCall,
  updateCallSession,
} from "@/lib/call-sessions";
import {
  appendSpeechGather,
  getTwilioCallContext,
  ROOF_QUESTION,
  twimlResponse,
} from "@/lib/twilio/helpers";

export async function POST(request: Request) {
  const formData = await request.formData();
  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const message = await generateVoiceResponse();
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(message);

  const initialQuestion = ROOF_QUESTION;

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
            ) ?? initialQuestion,
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
    prompt: initialQuestion,
  });

  return twimlResponse(twiml);
}
