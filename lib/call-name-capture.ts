import type { CollectedFields } from "@/lib/call-intake";
import {
  applyTargetedCorrection,
  hasCorrectionIntent,
  stripInterruptionPrefix,
} from "@/lib/call-intelligence";
import { isConfirmationPhrase, isCorrectionPhrase } from "@/lib/twilio/helpers";

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
    .replace(NAME_PREFIX_PATTERN, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  const explicitMatch = cleaned.match(
    /(?:^|\b)(?:my name is|name is|this is|i am|i'm|it's|it is|call me)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i,
  );

  if (explicitMatch?.[1]) {
    return normalizePersonName(explicitMatch[1]);
  }

  const directMatch = cleaned.match(
    /^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})$/,
  );

  if (directMatch?.[1]) {
    return normalizePersonName(directMatch[1]);
  }

  const looseMatch = cleaned.match(
    /([A-Za-z]{2,}(?:['-][A-Za-z]{2,})?(?:\s+[A-Za-z]{2,}(?:['-][A-Za-z]{2,})?){0,3})/,
  );

  if (looseMatch?.[1]) {
    return normalizePersonName(looseMatch[1]);
  }

  return null;
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
    return true;
  }

  return confidence < LOW_SPEECH_CONFIDENCE_THRESHOLD;
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

  fields = beginNameConfirmation(fields, speech, parsedName);

  return {
    status: "confirm",
    fields,
    replyText: buildNameConfirmationPrompt(parsedName),
    nameConfirmationRequested: true,
    nameCorrected: false,
  };
}
