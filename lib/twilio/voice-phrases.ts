export const OPENING_QUESTION = "What's going on with the roof?";

export const OPENING_GREETING =
  "Hi, thanks for calling Beau's Roofing. " +
  "I'm the AI assistant here to help. " +
  OPENING_QUESTION;

export const ROOF_QUESTION = OPENING_GREETING;

export const OPENING_RETRY_PROMPT =
  `I didn't catch that. ${OPENING_QUESTION}`;

export const NO_INPUT_RETRY_PROMPT = OPENING_RETRY_PROMPT;

export const NO_INPUT_FOLLOW_UP_PROMPT = "I didn't catch that. Please go ahead.";

export const NO_INPUT_GOODBYE =
  "Sorry, I couldn't hear you. Please call back when you're ready. Goodbye.";

/** Empty SpeechResult retries before ending the call (attempt 1 is the first miss). */
export const MAX_SPEECH_NO_INPUT_ATTEMPTS = 4;

export const CALLER_GOODBYE =
  "Thank you for calling Beau's Roofing. Have a wonderful day.";

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

export function isGoodbyePhrase(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return GOODBYE_PHRASES.some(
    (phrase) => normalized === phrase || normalized.includes(phrase),
  );
}

/** Only explicit hang-up words — not "that's all" / "all set" during intake. */
export function isExplicitCallerHangupDuringIntake(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(goodbye|good bye|bye|bye bye)\b/.test(normalized);
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
