import type { ResponseTriggerReason } from "../bridge/response-state-guard.js";

const PHONE_CONFIRMATION_PREFIX = /^just to confirm, your callback number is/i;
const ADDRESS_CONFIRMATION_PREFIX = /^and your service address is/i;

export function resolveConfirmationResponseReason(
  replyText: string,
): ResponseTriggerReason | null {
  const trimmed = replyText.trim();

  if (PHONE_CONFIRMATION_PREFIX.test(trimmed)) {
    return "phone_confirmation";
  }

  if (ADDRESS_CONFIRMATION_PREFIX.test(trimmed)) {
    return "address_confirmation";
  }

  return null;
}

export function isAtomicPhoneConfirmationReply(replyText: string): boolean {
  const trimmed = replyText.trim();
  return (
    PHONE_CONFIRMATION_PREFIX.test(trimmed) &&
    /\d{3}-\d{3}-\d{4}/.test(trimmed) &&
    /is that correct\?$/i.test(trimmed)
  );
}
