import { getCompanyPhoneE164 } from "../../../../lib/twilio/company-phone.js";

/** Normalize a customer callback number to E.164 when possible. */
export function normalizeCallbackPhoneE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (phone.trim().startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }

  return phone.trim();
}

/** Spoken groups like 402-555-5678 for US numbers. */
export function formatCallbackForSpeech(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);

  if (digits.length !== 10) {
    return phone.trim();
  }

  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function isCompanyPhoneNumber(phone: string): boolean {
  const normalized = normalizeCallbackPhoneE164(phone);
  const company = normalizeCallbackPhoneE164(getCompanyPhoneE164());
  return normalized === company;
}

export function buildCallbackReadbackConfirmation(phone: string): string {
  const spoken = formatCallbackForSpeech(phone);
  return `I have your callback number as ${spoken}. Is that correct?`;
}

export function isCallbackConfirmed(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that's correct|thats correct|affirmative)\b/.test(
    normalized,
  );
}

export function isCallbackRejected(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

/** Extract the newest explicit phone number from speech, honoring corrections. */
export function extractCallbackPhoneFromSpeech(
  speech: string,
  callerPhone?: string,
): string | null {
  const normalized = speech.toLowerCase();
  const phonePattern =
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;
  const matches = [...speech.matchAll(phonePattern)];

  if (matches.length > 0) {
    const hasCorrection =
      /\b(actually|make that|correction|instead|rather|change it to|should be)\b/i.test(
        speech,
      );
    const chosen = hasCorrection ? matches[matches.length - 1] : matches[0];
    const digits = chosen[0].replace(/\D/g, "");

    if (digits.length >= 10) {
      const e164 = normalizeCallbackPhoneE164(digits.slice(-10));

      if (!isCompanyPhoneNumber(e164)) {
        return e164;
      }
    }
  }

  if (
    callerPhone &&
    /^(yes|yeah|yep|correct|this one|that one|same number|this number|calling from)\b/i.test(
      normalized.trim(),
    )
  ) {
    const e164 = normalizeCallbackPhoneE164(callerPhone);

    if (!isCompanyPhoneNumber(e164)) {
      return e164;
    }
  }

  return null;
}
