import twilio from "twilio";
import { generateVoiceResponse } from "@/lib/ai/voice";
import {
  createTranscriptEntry,
  getCompanyIdByCalledPhone,
  getCurrentStage,
  getOrCreateCallSession,
  getStageQuestion,
  updateCallSession,
} from "@/lib/call-sessions";
import { createServiceClient } from "@/lib/supabase/service";
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

  const supabase = createServiceClient();

  if (supabase && callSid) {
    try {
      const companyId = await getCompanyIdByCalledPhone(supabase, calledPhone);

      if (companyId) {
        const session = await getOrCreateCallSession({
          callSid,
          companyId,
          callerPhone,
          calledPhone,
        });

        if (session) {
          const initialStage = getCurrentStage(
            session.collected_fields ?? { stage: "problem" },
          );

          await updateCallSession({
            callSid,
            currentQuestion: getStageQuestion(initialStage) ?? ROOF_QUESTION,
            collectedFields: {
              ...(session.collected_fields ?? {}),
              stage: initialStage,
            },
            transcriptEntry: createTranscriptEntry("assistant", message),
          });
        }
      }
    } catch (error) {
      console.error("Failed to initialize call session:", error);
    }
  }

  appendSpeechGather(twiml, request, {
    attempt: 1,
    initial: true,
    prompt: ROOF_QUESTION,
  });

  return twimlResponse(twiml);
}
