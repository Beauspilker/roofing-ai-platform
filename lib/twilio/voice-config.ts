/**
 * Central Twilio voice configuration.
 * Override TWILIO_VOICE in the environment to change the receptionist voice.
 */
export const TWILIO_VOICE: "Polly.Ruth-Neural" =
  (process.env.TWILIO_VOICE?.trim() as "Polly.Ruth-Neural" | undefined) ||
  "Polly.Ruth-Neural";

export const TWILIO_LANGUAGE = "en-US" as const;

export const SPOKEN_PROSODY = {
  rate: "92%",
  pitch: "-2%",
} as const;

export const SENTENCE_BREAK_MS = "350ms";

export const SPEECH_GATHER_OPTIONS = {
  enhanced: true,
  language: TWILIO_LANGUAGE,
  speechTimeout: "auto" as const,
  timeout: 4,
  hints:
    "roof, hail, shingles, leak, insurance, inspection, appointment, address, storm, damage, roofing",
};

export function getSayVoiceAttributes(): {
  voice: typeof TWILIO_VOICE;
  language: typeof TWILIO_LANGUAGE;
} {
  return {
    voice: TWILIO_VOICE,
    language: TWILIO_LANGUAGE,
  };
}
