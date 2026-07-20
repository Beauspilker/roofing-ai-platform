import type { RealtimeFields } from "./realtime-prompts.js";

/** Preserve confirmed nested values unless the caller clearly changed the underlying data. */
export function preserveConfirmedFieldState(
  before: RealtimeFields,
  after: RealtimeFields,
): RealtimeFields {
  const callbackUnchanged =
    (before.callback_phone?.trim() ?? "") === (after.callback_phone?.trim() ?? "");

  const addressUnchanged = (before.address?.trim() ?? "") === (after.address?.trim() ?? "");

  const nameUnchanged = (before.full_name?.trim() ?? "") === (after.full_name?.trim() ?? "");

  return {
    ...after,
    callback_phone_confirmed:
      callbackUnchanged && before.callback_phone_confirmed === true
        ? true
        : after.callback_phone_confirmed,
    address_confirmed:
      addressUnchanged && before.address_confirmed === true ? true : after.address_confirmed,
    full_name: nameUnchanged ? before.full_name ?? after.full_name : after.full_name,
    caller_name_declined:
      nameUnchanged ? before.caller_name_declined : after.caller_name_declined,
    caller_name_unavailable:
      nameUnchanged ? before.caller_name_unavailable : after.caller_name_unavailable,
  };
}
