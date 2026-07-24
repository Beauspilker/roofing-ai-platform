import {
  buildAddressReadbackConfirmation,
  sanitizeAddressValue,
} from "./address-confirmation.js";
import { buildCallbackReadbackConfirmation } from "./callback-phone.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export function buildPhoneConfirmationReply(fields: RealtimeFields): string {
  return buildCallbackReadbackConfirmation(fields.callback_phone ?? "");
}

export function buildAddressConfirmationReply(fields: RealtimeFields): string {
  const address = sanitizeAddressValue(fields.address ?? "");
  return buildAddressReadbackConfirmation(address);
}

export function phoneConfirmationExcludesAddress(
  reply: string,
  address?: string,
): boolean {
  if (!address?.trim()) {
    return true;
  }

  return !reply.toLowerCase().includes(sanitizeAddressValue(address).toLowerCase());
}

export function addressConfirmationExcludesPhone(
  reply: string,
  phone?: string,
): boolean {
  if (!phone?.trim()) {
    return !/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/.test(reply);
  }

  const digits = phone.replace(/\D/g, "").slice(-10);
  return !reply.includes(digits) && !reply.includes(phone);
}
