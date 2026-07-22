import type { CollectedFields } from "@/lib/call-intake";
import {
  applyTargetedCorrection,
  hasCorrectionIntent,
  stripInterruptionPrefix,
} from "@/lib/call-intelligence";
import { isConfirmationPhrase, isCorrectionPhrase } from "@/lib/twilio/voice-phrases";

export const MAX_NAME_CONFIRMATION_ATTEMPTS = 3;
export const LOW_SPEECH_CONFIDENCE_THRESHOLD = 0.72;

const NAME_PREFIX_PATTERN =
  /^(?:my name is|name is|this is|i am|i'm|it's|it is|call me)\s+/i;

const CORRECTION_PREFIX_PATTERN = /^(no|actually|wait|not|correction)[,.]?\s+/i;

function hasText(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAwaitingNameConfirmation(fields: CollectedFields): boolean {
  return (
    hasText(fields.name_pending_confirmation) && !hasText(fields.full_name)
  );
}

export function isAwaitingNameRepeat(fields: CollectedFields): boolean {
  return fields.name_awaiting_repeat === true && !hasText(fields.full_name);
}

export function normalizePersonName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) =>
      part
        .split("-")
        .map((segment) => {
          if (!segment) {
            return segment;
          }

          return (
            segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase()
          );
        })
        .join("-"),
    )
    .join(" ");
}

export function parseNameFromSpeech(text: string): string | null {
  const cleaned = stripInterruptionPrefix(text.trim())
    .replace(CORRECTION_PREFIX_PATTERN, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  const nonNameLeadIn =
    /^(?:i'?m|i am)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;

  if (nonNameLeadIn.test(cleaned)) {
    return null;
  }

  const positivePatterns = [
    /\b(?:my name is|name is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\bthis is\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\b(?:it'?s|it is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s*,\s*and\b)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)?)(?=\s*,)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+)\s+and\b/i,
    /\b(?:call me)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  ];

  for (const pattern of positivePatterns) {
    const match = cleaned.match(pattern);
    const candidate = match?.[1]?.trim();

    if (!candidate) {
      continue;
    }

    const refined = refineParsedNameCandidate(candidate);

    if (refined) {
      return normalizePersonName(refined);
    }
  }

  const withoutIntro = cleaned.replace(NAME_PREFIX_PATTERN, "").replace(/[.!?]+$/g, "").trim();
  const directMatch = withoutIntro.match(
    /^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})$/,
  );

  if (directMatch?.[1] && isPlausibleParsedName(directMatch[1])) {
    return normalizePersonName(directMatch[1]);
  }

  return null;
}

function refineParsedNameCandidate(candidate: string): string | null {
  const words = candidate.trim().split(/\s+/).filter(Boolean);

  for (let length = words.length; length >= 1; length -= 1) {
    const prefix = words.slice(0, length).join(" ");

    if (isPlausibleParsedName(prefix)) {
      return prefix;
    }
  }

  return null;
}

function isPlausibleParsedName(name: string): boolean {
  const trimmed = name.trim();

  if (trimmed.length < 2 || trimmed.length > 60 || /\d/.test(trimmed)) {
    return false;
  }

  const invalidExact =
    /^(calling|call|calling about|calling for|having|needing|looking|wondering|trying|reporting|asking|roof|roofing|damage|hail|storm|leak|shingles|insurance|claim|pictures|photos|appointment|today|tomorrow|yes|no|yeah|nope|yep|nah|correct|right)$/i;

  const words = trimmed.split(/\s+/);

  if (words.length === 0 || words.length > 4) {
    return false;
  }

  if (words.some((word) => invalidExact.test(word.toLowerCase()))) {
    return false;
  }

  if (
    /\b(hail|storm|roof|damage|leak|insurance|claim|appointment|pictures?|photos?)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  return /^[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3}$/.test(trimmed);
}

export function parseSpeechConfidence(
  confidence: string | null | undefined,
): number | null {
  if (!confidence) {
    return null;
  }

  const parsed = Number.parseFloat(confidence);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function shouldConfirmRecognizedName(
  confidence: number | null,
): boolean {
  if (confidence === null) {
    return false;
  }

  return confidence < LOW_SPEECH_CONFIDENCE_THRESHOLD;
}

const COMMON_SURNAMES = new Set([
  "smith",
  "johnson",
  "williams",
  "brown",
  "jones",
  "garcia",
  "miller",
  "davis",
  "wilson",
  "anderson",
  "taylor",
  "moore",
  "martin",
  "thompson",
  "white",
  "harris",
  "clark",
  "lewis",
  "walker",
  "hall",
  "young",
  "allen",
  "king",
  "wright",
  "scott",
  "green",
  "baker",
  "adams",
  "nelson",
  "hill",
]);

export function isNameRecognitionUncertain(parsedName: string): boolean {
  const words = parsedName.trim().split(/\s+/).filter(Boolean);

  if (words.length < 2) {
    return false;
  }

  const lastName = words.slice(1).join(" ");
  const normalized = lastName.toLowerCase();

  if (COMMON_SURNAMES.has(normalized)) {
    return false;
  }

  return (
    normalized.length >= 7 ||
    /[^a-z'-]/i.test(lastName) ||
    /[qxz]/i.test(normalized)
  );
}

export function shouldRequestNameConfirmation(input: {
  parsedName: string;
  confidence: number | null;
  nameNeedsClarification?: boolean;
}): boolean {
  if (shouldConfirmRecognizedName(input.confidence)) {
    return true;
  }

  if (input.nameNeedsClarification === true) {
    return true;
  }

  return isNameRecognitionUncertain(input.parsedName);
}

export function buildNameConfirmationPrompt(name: string): string {
  return `I heard ${name}. Is that correct?`;
}

export function buildNameRepeatPrompt(): string {
  return "Sorry about that. Please say your first and last name again.";
}

export function clearNameCaptureState(
  fields: CollectedFields,
): CollectedFields {
  return {
    ...fields,
    name_pending_confirmation: undefined,
    name_raw_speech: undefined,
    name_awaiting_repeat: undefined,
    name_confirmation_attempts: undefined,
  };
}

function acceptPendingName(fields: CollectedFields): CollectedFields {
  const pending = fields.name_pending_confirmation?.trim();

  if (!pending) {
    return fields;
  }

  return clearNameCaptureState({
    ...fields,
    full_name: pending,
  });
}

function beginNameConfirmation(
  fields: CollectedFields,
  rawSpeech: string,
  parsedName: string,
): CollectedFields {
  return {
    ...fields,
    name_pending_confirmation: parsedName,
    name_raw_speech: rawSpeech.trim(),
    name_awaiting_repeat: false,
  };
}

function incrementNameConfirmationAttempts(
  fields: CollectedFields,
): CollectedFields {
  return {
    ...fields,
    name_confirmation_attempts: (fields.name_confirmation_attempts ?? 0) + 1,
  };
}

function isNameOnlyCorrection(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /\b(last name|first name|surname|spelling)\b/.test(normalized) ||
    /\bwith an? [a-z]\b/i.test(speech)
  );
}

export type NameCaptureOutcome =
  | {
      status: "confirm";
      fields: CollectedFields;
      replyText: string;
      nameConfirmationRequested: true;
      nameCorrected: boolean;
    }
  | {
      status: "repeat";
      fields: CollectedFields;
      replyText: string;
      nameConfirmationRequested: false;
      nameCorrected: boolean;
    }
  | {
      status: "accepted";
      fields: CollectedFields;
      replyText: null;
      nameConfirmationRequested: false;
      nameCorrected: boolean;
    };

export function processNameCaptureTurn(input: {
  fields: CollectedFields;
  speech: string;
  confidence: number | null;
}): NameCaptureOutcome {
  const speech = input.speech.trim();
  let fields = { ...input.fields };
  let nameCorrected = false;

  if (isAwaitingNameConfirmation(fields)) {
    const pendingName = fields.name_pending_confirmation?.trim() ?? "";

    if (
      isConfirmationPhrase(speech) &&
      !hasCorrectionIntent(speech) &&
      !isCorrectionPhrase(speech)
    ) {
      return {
        status: "accepted",
        fields: acceptPendingName(fields),
        replyText: null,
        nameConfirmationRequested: false,
        nameCorrected: false,
      };
    }

    const correction = applyTargetedCorrection(
      fields,
      speech,
      "full_name",
    );

    if (correction.updated && correction.field === "full_name") {
      const correctedName = normalizePersonName(
        correction.fields.full_name ?? pendingName,
      );

      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, correctedName),
        replyText: buildNameConfirmationPrompt(correctedName),
        nameConfirmationRequested: true,
        nameCorrected: true,
      };
    }

    const parsedCorrection = parseNameFromSpeech(speech);

    if (parsedCorrection && (hasCorrectionIntent(speech) || isCorrectionPhrase(speech))) {
      nameCorrected = true;

      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, parsedCorrection),
        replyText: buildNameConfirmationPrompt(parsedCorrection),
        nameConfirmationRequested: true,
        nameCorrected: true,
      };
    }

    if (
      isCorrectionPhrase(speech) ||
      hasCorrectionIntent(speech) ||
      isNameOnlyCorrection(speech)
    ) {
      fields = incrementNameConfirmationAttempts({
        ...clearNameCaptureState(fields),
        name_awaiting_repeat: true,
      });

      if ((fields.name_confirmation_attempts ?? 0) >= MAX_NAME_CONFIRMATION_ATTEMPTS) {
        return {
          status: "accepted",
          fields: acceptPendingName({
            ...fields,
            name_pending_confirmation: pendingName,
          }),
          replyText: null,
          nameConfirmationRequested: false,
          nameCorrected: false,
        };
      }

      return {
        status: "repeat",
        fields,
        replyText: buildNameRepeatPrompt(),
        nameConfirmationRequested: false,
        nameCorrected: true,
      };
    }

    if (parsedCorrection && parsedCorrection.toLowerCase() !== pendingName.toLowerCase()) {
      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, parsedCorrection),
        replyText: buildNameConfirmationPrompt(parsedCorrection),
        nameConfirmationRequested: true,
        nameCorrected: true,
      };
    }

    return {
      status: "confirm",
      fields,
      replyText: buildNameConfirmationPrompt(pendingName),
      nameConfirmationRequested: true,
      nameCorrected: false,
    };
  }

  const parsedName = parseNameFromSpeech(speech);

  if (!parsedName) {
    fields = incrementNameConfirmationAttempts({
      ...fields,
      name_awaiting_repeat: true,
    });

    if ((fields.name_confirmation_attempts ?? 0) >= MAX_NAME_CONFIRMATION_ATTEMPTS) {
      const fallbackName = normalizePersonName(speech);

      return {
        status: "accepted",
        fields: clearNameCaptureState({
          ...fields,
          full_name: fallbackName,
        }),
        replyText: null,
        nameConfirmationRequested: false,
        nameCorrected: false,
      };
    }

    return {
      status: "repeat",
      fields: clearNameCaptureState({
        ...fields,
        name_awaiting_repeat: true,
      }),
      replyText: buildNameRepeatPrompt(),
      nameConfirmationRequested: false,
      nameCorrected: false,
    };
  }

  if (
    !shouldRequestNameConfirmation({
      parsedName,
      confidence: input.confidence,
      nameNeedsClarification: fields.name_needs_clarification === true,
    })
  ) {
    return {
      status: "accepted",
      fields: clearNameCaptureState({
        ...fields,
        full_name: parsedName,
      }),
      replyText: null,
      nameConfirmationRequested: false,
      nameCorrected: false,
    };
  }

  fields = beginNameConfirmation(fields, speech, parsedName);

  return {
    status: "confirm",
    fields,
    replyText: buildNameConfirmationPrompt(parsedName),
    nameConfirmationRequested: true,
    nameCorrected: false,
  };
}
