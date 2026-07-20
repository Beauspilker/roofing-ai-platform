import type { RealtimeFields } from "./realtime-prompts.js";
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
  let formatted = address.trim().replace(/\s+/g, " ");

  if (/\bin\b/i.test(formatted) && !/,/.test(formatted)) {
    formatted = formatted.replace(/\s+in\s+/i, ", ");
  }

  return formatted;
}

export function buildAddressReadbackConfirmation(address: string): string {
  return `I have ${formatAddressForSpeech(address)}. Is that right?`;
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

export function applyAddressCorrection(fields: RealtimeFields, speech: string): RealtimeFields {
  const trimmed = speech.trim();

  if (!trimmed) {
    return fields;
  }

  return syncLegacyStringFields({
    ...fields,
    address: trimmed.slice(0, 500),
    address_confirmed: false,
  });
}

export function confirmAddress(fields: RealtimeFields): RealtimeFields {
  return syncLegacyStringFields({
    ...fields,
    address: fields.address ? formatAddressForSpeech(fields.address) : fields.address,
    address_confirmed: true,
  });
}
