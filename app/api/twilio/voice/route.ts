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
import { validateTwilioRequest } from "@/lib/twilio/signature";
import { buildMediaStreamConnectTwiml } from "@/lib/twilio/stream-twiml";
import { hasStreamSigningSecret } from "@/lib/twilio/stream-auth";
import {
  getRealtimeWebSocketUrl,
  isRealtimeVoiceConfigured,
} from "@/lib/twilio/voice-mode";

function buildLegacyVoiceTwiml(
  request: Request,
  message: string,
): twilio.twiml.VoiceResponse {
  const twiml = new twilio.twiml.VoiceResponse();
  appendSpokenSay(twiml, message);
  appendSpeechGather(twiml, request, {
    attempt: 1,
    initial: true,
  });
  return twiml;
}

async function initializeCallSession(
  callSid: string,
  callerPhone: string,
  calledPhone: string,
  message: string,
): Promise<void> {
  if (!callSid) {
    return;
  }

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

function buildRealtimeVoiceTwiml(
  callSid: string,
  callerPhone: string,
  calledPhone: string,
): twilio.twiml.VoiceResponse | null {
  const websocketUrl = getRealtimeWebSocketUrl();

  if (!websocketUrl || !hasStreamSigningSecret()) {
    return null;
  }

  return buildMediaStreamConnectTwiml(websocketUrl, {
    callSid,
    callerPhone,
    calledPhone,
  });
}

export async function POST(request: Request) {
  const formData = await request.formData();

  if (!validateTwilioRequest(request, formData)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { callSid, callerPhone, calledPhone } = getTwilioCallContext(formData);
  const message = OPENING_GREETING;

  await initializeCallSession(callSid, callerPhone, calledPhone, message);

  if (isRealtimeVoiceConfigured() && callSid) {
    try {
      const streamTwiml = buildRealtimeVoiceTwiml(
        callSid,
        callerPhone,
        calledPhone,
      );

      if (streamTwiml) {
        console.info(
          JSON.stringify({
            event: "voice_realtime_stream_selected",
            callSid,
          }),
        );
        return twimlResponse(streamTwiml);
      }

      console.warn(
        JSON.stringify({
          event: "voice_realtime_fallback",
          callSid,
          reason: "stream_twiml_unavailable",
        }),
      );
    } catch (error) {
      console.error("Realtime voice setup failed; falling back to legacy:", error);
    }
  }

  return twimlResponse(buildLegacyVoiceTwiml(request, message));
}
