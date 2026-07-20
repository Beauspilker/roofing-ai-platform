/** Default Beau's Roofing company-owned Twilio number (E.164). */
export const DEFAULT_COMPANY_PHONE_E164 = "+14027611540";

/** Human-readable display for the company number. */
export const DEFAULT_COMPANY_PHONE_DISPLAY = "(402) 761-1540";

/**
 * Company-owned outbound/inbound business number.
 * Source of truth: TWILIO_PHONE_NUMBER env var, then DEFAULT_COMPANY_PHONE_E164.
 * Distinct from the caller's callback number captured during intake.
 */
export function getCompanyPhoneE164(): string {
  return process.env.TWILIO_PHONE_NUMBER?.trim() || DEFAULT_COMPANY_PHONE_E164;
}

export function getCompanyPhoneDisplay(): string {
  return DEFAULT_COMPANY_PHONE_DISPLAY;
}
