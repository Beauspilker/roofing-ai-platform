import twilio from "twilio";

export type TwilioSmsSendResult =
  | { delivered: true; sid: string; simulated: false }
  | { delivered: false; simulated: true; reason: string };

function getTwilioSmsConfig(): {
  accountSid: string;
  authToken: string;
  fromNumber: string;
} | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim();

  if (!accountSid || !authToken || !fromNumber) {
    return null;
  }

  return { accountSid, authToken, fromNumber };
}

export async function sendTwilioSms(
  to: string,
  body: string,
): Promise<TwilioSmsSendResult> {
  const trimmedTo = to.trim();
  const trimmedBody = body.trim();

  if (!trimmedTo || !trimmedBody) {
    return {
      delivered: false,
      simulated: true,
      reason: "missing_recipient_or_body",
    };
  }

  const config = getTwilioSmsConfig();

  if (!config) {
    return {
      delivered: false,
      simulated: true,
      reason: "twilio_not_configured",
    };
  }

  try {
    const client = twilio(config.accountSid, config.authToken);
    const message = await client.messages.create({
      to: trimmedTo,
      from: config.fromNumber,
      body: trimmedBody,
    });

    return {
      delivered: true,
      sid: message.sid,
      simulated: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Twilio SMS failed: ${reason}`);
  }
}

export function isTwilioSmsConfigured(): boolean {
  return getTwilioSmsConfig() !== null;
}
