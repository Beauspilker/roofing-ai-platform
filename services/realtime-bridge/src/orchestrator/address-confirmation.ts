import type { RealtimeFields } from "./realtime-prompts.js";
import {
  containsNonAddressContinuation,
  normalizeAddressPunctuation,
  sanitizeServiceAddress,
} from "./address-sanitization.js";
import { markFieldConfirmed } from "./field-completion.js";
import { syncLegacyStringFields } from "./structured-intake.js";

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Minimum signal that an address is worth reading back. */
export function hasConfirmableAddress(address: string | undefined): boolean {
  if (!hasValue(address)) {
    return false;
  }

  const trimmed = address!.trim();
  return /\d/.test(trimmed) && trimmed.length >= 8;
}

export function formatAddressForSpeech(address: string): string {
  return normalizeAddressPunctuation(address);
}

export function sanitizeAddressValue(address: string): string {
  const stripped = address
    .replace(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g, " ")
    .replace(/\b(call me at|my number is|phone number is|callback number is)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (containsNonAddressContinuation(stripped)) {
    return sanitizeServiceAddress(stripped) ?? stripped.replace(/[,.]$/, "").trim();
  }

  return stripped;
}

export function buildAddressReadbackConfirmation(address: string): string {
  return `And your service address is ${formatAddressForSpeech(sanitizeAddressValue(address))}. Is that correct?`;
}

export function needsAddressReadback(fields: RealtimeFields): boolean {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed !== true;
}

export function isAddressConfirmed(fields: RealtimeFields): boolean {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed === true;
}

function normalizeConfirmationSpeech(speech: string): string {
  return speech
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ADDRESS_CONFIRMATION_AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|correct|right|that s right|that s correct|affirmative|uh huh|uhhuh|mm hmm|mhm)\b/;

export function isAddressConfirmedSpeech(speech: string): boolean {
  const normalized = normalizeConfirmationSpeech(speech);

  if (!normalized) {
    return false;
  }

  if (
    /^(yes|yeah|yep|yup|correct|right|that s right|that s correct|affirmative|uh huh|uhhuh|mm hmm|mhm)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /^(uh|um|okay|ok|sure|alright|well|so|oh)\b/.test(normalized) &&
    ADDRESS_CONFIRMATION_AFFIRMATIVE.test(normalized)
  ) {
    return true;
  }

  if (normalized.split(/\s+/).length <= 5 && ADDRESS_CONFIRMATION_AFFIRMATIVE.test(normalized)) {
    return true;
  }

  return false;
}

export function isAddressRejectedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

export function confirmAddress(fields: RealtimeFields): RealtimeFields {
  const sanitized = fields.address
    ? sanitizeServiceAddress(fields.address) ?? formatAddressForSpeech(fields.address)
    : fields.address;

  return markFieldConfirmed(
    syncLegacyStringFields({
      ...fields,
      address: sanitized,
      address_confirmed: true,
      pending_question:
        fields.pending_question === "address_confirmation" ||
        fields.pending_question === "service_address"
          ? undefined
          : fields.pending_question,
      field_being_confirmed:
        fields.field_being_confirmed === "address" ? undefined : fields.field_being_confirmed,
      confirmation_candidate:
        fields.field_being_confirmed === "address" ? undefined : fields.confirmation_candidate,
      activeConfirmationField:
        fields.activeConfirmationField === "address" ? undefined : fields.activeConfirmationField,
      activeConfirmationValue:
        fields.activeConfirmationField === "address" ? undefined : fields.activeConfirmationValue,
      current_field_value:
        fields.field_being_confirmed === "address" ? undefined : fields.current_field_value,
      confirmation_attempt_count: undefined,
      correctionAttemptCount: undefined,
      confirmationStatus: undefined,
      pending_correction_hint: undefined,
      confirmation_last_outcome: "accepted",
    }),
    "address",
  );
}
