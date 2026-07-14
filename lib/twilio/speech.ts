import twilio from "twilio";
import { getSayVoiceAttributes } from "@/lib/twilio/voice-config";

type SayContainer = {
  say: twilio.twiml.VoiceResponse["say"];
};

export function prepareSpokenText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\bi am\b/gi, "I'm")
    .replace(/\bi have\b/gi, "I've")
    .replace(/\bwe have\b/gi, "we've")
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\bI will\b/g, "I'll")
    .replace(/\bit is\b/gi, "it's")
    .replace(/\s+,/g, ",")
    .trim();
}

export function appendSpokenSay(parent: SayContainer, text: string): void {
  const prepared = prepareSpokenText(text);

  if (!prepared) {
    return;
  }

  parent.say(getSayVoiceAttributes(), prepared);
}
