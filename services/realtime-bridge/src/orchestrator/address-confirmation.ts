import type { RealtimeFields } from "./realtime-prompts.js";
import {
  containsNonAddressContinuation,
  normalizeAddressPunctuation,
  sanitizeServiceAddress,
} from "./address-sanitization.js";
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

export function isAddressConfirmedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that's correct|thats correct)\b/.test(
    normalized,
  );
}

export function isAddressRejectedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

export function confirmAddress(fields: RealtimeFields): RealtimeFields {
  const sanitized = fields.address
    ? sanitizeServiceAddress(fields.address) ?? formatAddressForSpeech(fields.address)
    : fields.address;

  return syncLegacyStringFields({
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
  });
}
