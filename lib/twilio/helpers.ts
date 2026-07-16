import { NextResponse } from "next/server";
import twilio from "twilio";
import { appendSpokenSay } from "@/lib/twilio/speech";
import { getSpeechGatherOptionsForStage } from "@/lib/twilio/voice-config";

export {
  CALLER_GOODBYE,
  isConfirmationPhrase,
  isCorrectionPhrase,
  isGoodbyePhrase,
  MAX_SPEECH_NO_INPUT_ATTEMPTS,
  NO_INPUT_FOLLOW_UP_PROMPT,
  NO_INPUT_GOODBYE,
  NO_INPUT_RETRY_PROMPT,
  OPENING_GREETING,
  OPENING_QUESTION,
  OPENING_RETRY_PROMPT,
  ROOF_QUESTION,
} from "@/lib/twilio/voice-phrases";

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

export function getSpeechConfidence(formData: FormData): string | null {
  const confidence = formData.get("Confidence")?.toString().trim();
  return confidence || null;
}

export function redactCallSid(callSid: string): string {
  if (callSid.length <= 8) {
    return callSid;
  }

  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}

export function logSpeechGatherTurn(input: {
  callSid: string;
  attempt: number;
  isInitial: boolean;
  hasSpeechResult: boolean;
  confidence: string | null;
  stage: string | null;
  outcome: "empty" | "received" | "continue" | "hangup";
  nameConfirmationRequested?: boolean;
  nameCorrected?: boolean;
}): void {
  console.info(
    JSON.stringify({
      event: "twilio_speech_gather",
      callSid: redactCallSid(input.callSid),
      attempt: input.attempt,
      isInitial: input.isInitial,
      hasSpeechResult: input.hasSpeechResult,
      confidence: input.confidence,
      stage: input.stage,
      outcome: input.outcome,
      nameConfirmationRequested: input.nameConfirmationRequested ?? false,
      nameCorrected: input.nameCorrected ?? false,
      voicePath: "legacy_gather",
    }),
  );
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

export function appendSpeechGather(
  twiml: twilio.twiml.VoiceResponse,
  request: Request,
  options: {
    attempt: number;
    initial?: boolean;
    prompt?: string | null;
    hints?: string;
    stage?: string | null;
  },
): void {
  const origin = getRequestOrigin(request);
  const params = new URLSearchParams({
    attempt: String(options.attempt),
  });

  if (options.initial) {
    params.set("initial", "1");
  }

  const gatherOptions = getSpeechGatherOptionsForStage(options.stage ?? null);

  const gather = twiml.gather({
    input: ["speech"],
    action: `${origin}/api/twilio/conversation?${params.toString()}`,
    method: "POST",
    actionOnEmptyResult: true,
    bargeIn: true,
    ...gatherOptions,
    hints: options.hints ?? gatherOptions.hints,
  });

  if (options.prompt) {
    appendSpokenSay(gather, options.prompt);
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
