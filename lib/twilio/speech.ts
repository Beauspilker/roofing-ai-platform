import twilio from "twilio";
import {
  getSayVoiceAttributes,
  SENTENCE_BREAK_MS,
  SPOKEN_PROSODY,
} from "@/lib/twilio/voice-config";

const BRAND_TOKEN = "{{BRAND}}";
const PHONE_PATTERN =
  /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;

type SayContainer = {
  say: twilio.twiml.VoiceResponse["say"];
};

type TwilioSay = ReturnType<SayContainer["say"]>;

type SpeechPart =
  | { kind: "text"; value: string }
  | { kind: "brand" }
  | { kind: "phone"; value: string };

export function prepareSpokenText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\bBeau's Roofing\b/g, BRAND_TOKEN)
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

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitPhoneParts(text: string): SpeechPart[] {
  const parts: SpeechPart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PHONE_PATTERN)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      const chunk = text.slice(lastIndex, index).trim();
      if (chunk) {
        parts.push({ kind: "text", value: chunk });
      }
    }

    parts.push({ kind: "phone", value: match[0] });
    lastIndex = index + match[0].length;
  }

  const tail = text.slice(lastIndex).trim();
  if (tail) {
    parts.push({ kind: "text", value: tail });
  }

  return parts.length > 0 ? parts : [{ kind: "text", value: text.trim() }];
}

function renderTextPart(
  say: TwilioSay,
  text: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  say.prosody(SPOKEN_PROSODY, trimmed);
}

function renderSpeechPart(
  say: TwilioSay,
  part: SpeechPart,
): void {
  switch (part.kind) {
    case "brand":
      say.sub({ alias: "Bo's Roofing" }, "Beau's Roofing");
      break;
    case "phone":
      say.sayAs(
        { "interpret-as": "telephone" },
        part.value.replace(/\D/g, ""),
      );
      break;
    case "text":
      renderTextPart(say, part.value);
      break;
  }
}

function renderSentence(
  say: TwilioSay,
  sentence: string,
): void {
  const brandParts = sentence.includes(BRAND_TOKEN)
    ? sentence.split(BRAND_TOKEN)
    : [sentence];

  brandParts.forEach((segment, index) => {
    if (segment) {
      for (const part of splitPhoneParts(segment)) {
        renderSpeechPart(say, part);
      }
    }

    if (index < brandParts.length - 1) {
      renderSpeechPart(say, { kind: "brand" });
    }
  });
}

export function appendSpokenSay(parent: SayContainer, text: string): void {
  const prepared = prepareSpokenText(text);
  const say = parent.say(getSayVoiceAttributes(), "");
  const sentences = splitSentences(prepared);

  if (sentences.length === 0) {
    renderTextPart(say, prepared);
    return;
  }

  sentences.forEach((sentence, index) => {
    renderSentence(say, sentence);

    if (index < sentences.length - 1) {
      say.break({ time: SENTENCE_BREAK_MS });
    }
  });
}
