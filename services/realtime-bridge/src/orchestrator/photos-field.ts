import type { RealtimeFields } from "./realtime-prompts.js";
import type { PendingQuestionKey } from "./pending-question.js";

/** Authoritative photos intake value — null/undefined only before first answer. */
export type PhotosAvailability = boolean | "unknown" | "declined" | null;

export function isPhotosResolved(
  value: PhotosAvailability | undefined,
): value is boolean | "unknown" | "declined" {
  return (
    value === true ||
    value === false ||
    value === "unknown" ||
    value === "declined"
  );
}

export function isPhotosFieldComplete(fields: RealtimeFields): boolean {
  return isPhotosResolved(normalizePhotosValue(fields.photos_available));
}

export function normalizePhotosValue(
  value: PhotosAvailability | string | undefined,
): PhotosAvailability {
  if (value === true || value === false || value === "unknown" || value === "declined") {
    return value;
  }

  if (value === "yes") {
    return true;
  }

  if (value === "no") {
    return false;
  }

  if (value === "unknown") {
    return "unknown";
  }

  if (value === "declined") {
    return "declined";
  }

  if (value === null || value === undefined) {
    return null;
  }

  return null;
}

export function parsePhotosAnswerWhenPending(
  speech: string,
  pendingQuestion: PendingQuestionKey | null,
): PhotosAvailability | null {
  if (pendingQuestion !== "photos_available") {
    return null;
  }

  const normalized = speech.trim().toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (
    /\b(rather not say|prefer not|rather not|don't want to say|do not want to say|won't say|will not say)\b/.test(
      normalized,
    )
  ) {
    return "declined";
  }

  if (/\b(not sure|unsure|don't know|do not know|maybe|uncertain)\b/.test(normalized)) {
    return "unknown";
  }

  if (
    /^(yes|yeah|yep|yup|sure|correct|right|i do|i have|i've got|we do|we have|i have some|we have some)\b/.test(
      normalized,
    ) ||
    /\b(i have (some )?(photos|pictures|images)|got (some )?(photos|pictures|images))\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/^(no|nope|nah|none|don't|dont|i don't|i dont|we don't|we dont|not really)\b/.test(normalized)) {
    return false;
  }

  if (/\b(no photos|no pictures|don't have|dont have|haven't taken|havent taken)\b/.test(normalized)) {
    return false;
  }

  return null;
}

export function applyPhotosPendingAnswer(
  fields: RealtimeFields,
  speech: string,
  pendingQuestion: PendingQuestionKey | null,
): RealtimeFields {
  const parsed = parsePhotosAnswerWhenPending(speech, pendingQuestion);

  if (parsed === null || isPhotosResolved(fields.photos_available as PhotosAvailability)) {
    return fields;
  }

  return {
    ...fields,
    photos_available: parsed,
    pending_question: undefined,
  };
}

export function photosAffirmativeAcknowledgment(value: PhotosAvailability): string | null {
  if (value === true) {
    return "Great. You'll be able to send those safely after the call.";
  }

  return null;
}
