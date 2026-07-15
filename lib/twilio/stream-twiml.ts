import twilio from "twilio";
import { createStreamAuthToken } from "@/lib/twilio/stream-auth";

export type MediaStreamConnectParams = {
  callSid: string;
  callerPhone: string;
  calledPhone: string;
};

export function buildMediaStreamConnectTwiml(
  websocketUrl: string,
  params: MediaStreamConnectParams,
): twilio.twiml.VoiceResponse | null {
  const token = createStreamAuthToken(params.callSid);

  if (!token) {
    console.error(
      "Cannot build Media Stream TwiML: REALTIME_BRIDGE_SIGNING_SECRET is not configured.",
    );
    return null;
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: websocketUrl });

  stream.parameter({ name: "callSid", value: params.callSid });
  stream.parameter({ name: "token", value: token });

  if (params.callerPhone) {
    stream.parameter({ name: "callerPhone", value: params.callerPhone });
  }

  if (params.calledPhone) {
    stream.parameter({ name: "calledPhone", value: params.calledPhone });
  }

  return twiml;
}
