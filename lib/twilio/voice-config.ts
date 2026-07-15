/**
 * Central Twilio voice configuration.
 * Override TWILIO_VOICE in the environment to change the receptionist voice.
 */
export const DEFAULT_TWILIO_VOICE = "Polly.Joanna" as const;

export type AllowedTwilioVoice =
  | typeof DEFAULT_TWILIO_VOICE
  | "Polly.Matthew"
  | "Polly.Joanna-Neural"
  | "Polly.Matthew-Neural"
  | "Polly.Kendra"
  | "Polly.Kimberly"
  | "Polly.Salli"
  | "Polly.Ivy"
  | "man"
  | "woman"
  | "alice";

export const TWILIO_LANGUAGE = "en-US" as const;

const ALLOWED_TWILIO_VOICES = new Set<string>([
  "Polly.Joanna",
  "Polly.Matthew",
  "Polly.Joanna-Neural",
  "Polly.Matthew-Neural",
  "Polly.Kendra",
  "Polly.Kimberly",
  "Polly.Salli",
  "Polly.Ivy",
  "man",
  "woman",
  "alice",
]);

export function resolveTwilioVoice(configured?: string): AllowedTwilioVoice {
  const trimmed = configured?.trim();

  if (trimmed && ALLOWED_TWILIO_VOICES.has(trimmed)) {
    return trimmed as AllowedTwilioVoice;
  }

  return DEFAULT_TWILIO_VOICE;
}

export const TWILIO_VOICE = resolveTwilioVoice(process.env.TWILIO_VOICE);

export const SPEECH_GATHER_OPTIONS = {
  enhanced: true,
  language: TWILIO_LANGUAGE,
  speechModel: "phone_call" as const,
  speechTimeout: "4",
  timeout: 10,
  hints:
    "roof, hail, shingles, leak, insurance, inspection, appointment, address, storm, damage, roofing, name, phone number, street, city, zip code",
};

export function getSayVoiceAttributes(): {
  voice: AllowedTwilioVoice;
  language: typeof TWILIO_LANGUAGE;
} {
  return {
    voice: TWILIO_VOICE,
    language: TWILIO_LANGUAGE,
  };
}
