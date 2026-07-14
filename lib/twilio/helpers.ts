import { NextResponse } from "next/server";
import twilio from "twilio";

export const OPENING_QUESTION = "Could you tell me what's going on?";

export const OPENING_GREETING =
  "Hi, thanks for calling Beau's Roofing. " +
  "I'm the company's AI assistant, and I'm here to help get you taken care of today. " +
  OPENING_QUESTION;

export const ROOF_QUESTION = OPENING_GREETING;

export const OPENING_RETRY_PROMPT =
  `I didn't catch that. ${OPENING_QUESTION}`;

export const NO_INPUT_RETRY_PROMPT = OPENING_RETRY_PROMPT;

export const NO_INPUT_FOLLOW_UP_PROMPT = "I didn't catch that. Please go ahead.";

export const NO_INPUT_GOODBYE =
  "I'm sorry, I wasn't able to hear you. Please call back when you're ready. Goodbye!";

export const CALLER_GOODBYE =
  "Thank you for calling Beau's Roofing. Have a great day!";

const GOODBYE_PHRASES = [
  "goodbye",
  "good bye",
  "bye",
  "that's all",
  "thats all",
  "that is all",
  "no thank you",
  "no thanks",
  "nothing else",
  "i'm good",
  "im good",
  "all set",
];

export function getRequestOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";

  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost.split(",")[0]?.trim()}`;
  }

  return new URL(request.url).origin;
}

export function getSpeechResult(formData: FormData): string {
  return formData.get("SpeechResult")?.toString().trim() ?? "";
}

export function getTwilioCallContext(formData: FormData): {
  callSid: string;
  callerPhone: string;
  calledPhone: string;
} {
  const calledPhone =
    formData.get("To")?.toString().trim() ||
    formData.get("Called")?.toString().trim() ||
    "";

  return {
    callSid: formData.get("CallSid")?.toString().trim() ?? "",
    callerPhone: formData.get("From")?.toString().trim() ?? "",
    calledPhone,
  };
}

export function isGoodbyePhrase(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return GOODBYE_PHRASES.some(
    (phrase) => normalized === phrase || normalized.includes(phrase),
  );
}

export function isConfirmationPhrase(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /^(yes|yeah|yep|yup|correct|right|exactly|sure|absolutely|sounds good|sound good|that'?s right|thats right|that is correct|all good|perfect|ok(?:ay)?)\b/.test(
      normalized,
    ) || normalized === "uh huh"
  );
}

export function isCorrectionPhrase(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|that'?s wrong|thats wrong|not right|actually)\b/.test(
    normalized,
  );
}

export function appendSpeechGather(
  twiml: twilio.twiml.VoiceResponse,
  request: Request,
  options: {
    attempt: number;
    initial?: boolean;
    prompt?: string | null;
  },
): void {
  const origin = getRequestOrigin(request);
  const params = new URLSearchParams({
    attempt: String(options.attempt),
  });

  if (options.initial) {
    params.set("initial", "1");
  }

  const gather = twiml.gather({
    input: ["speech"],
    action: `${origin}/api/twilio/conversation?${params.toString()}`,
    method: "POST",
    actionOnEmptyResult: true,
    speechTimeout: "auto",
  });

  if (options.prompt) {
    gather.say(options.prompt);
  }
}

export function twimlResponse(twiml: twilio.twiml.VoiceResponse): NextResponse {
  return new NextResponse(twiml.toString(), {
    status: 200,
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
