import {
  formatAddressForSpeech,
  hasConfirmableAddress,
  sanitizeAddressValue,
} from "./address-confirmation.js";
import {
  buildAddressConfirmationReply as buildAddressConfirmationReplyFromFields,
  buildPhoneConfirmationReply as buildPhoneConfirmationReplyFromFields,
} from "./confirmation-builders.js";
import {
  extractCallbackPhoneFromSpeech,
  formatCallbackForSpeech,
  isCompanyPhoneNumber,
  normalizeCallbackPhoneE164,
} from "./callback-phone.js";
import { extractAddressFromSpeech } from "./multi-field-extraction.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import { syncLegacyStringFields } from "./structured-intake.js";
import { isPlausibleServiceAddress } from "./field-validation.js";

export type ConfirmableFieldKey =
  | "callback_phone"
  | "address"
  | "full_name"
  | "appointment_preference";

export type ConfirmationOutcome =
  | "accepted"
  | "rejected"
  | "corrected"
  | "unchanged"
  | "needs_clarification";

export type FieldConfirmationResult = {
  fields: RealtimeFields;
  outcome: ConfirmationOutcome;
  replyText?: string;
  updated: boolean;
};

const CONVERSATIONAL_PREFIXES: RegExp[] = [
  /^everything is correct except\s+/i,
  /^everything is right except\s+/i,
  /^you got everything right but\s+/i,
  /^you got it right but\s+/i,
  /^the only thing is\s+/i,
  /^just change\s+/i,
  /^just add\s+/i,
  /^just to change\s+/i,
  /^actually,?\s+/i,
  /^no,?\s*i meant\s+/i,
  /^no,?\s*it should be\s+/i,
  /^correction,?\s+/i,
  /^what i meant was\s+/i,
];

export type StructuredCorrectionOperation =
  | "replace_full_value"
  | "append"
  | "remove"
  | "replace_fragment"
  | "replace_digit"
  | "replace_street_direction"
  | "replace_unit"
  | "replace_zip";

export type StructuredFieldCorrection = {
  targetField: ConfirmableFieldKey;
  operation: StructuredCorrectionOperation;
  replacementValue?: string;
  fragmentToAdd?: string;
  fragmentToRemove?: string;
  fragmentToReplace?: string;
  confidence: "high" | "medium" | "low";
  requiresClarification: boolean;
  clarificationHint?: string;
};

const MAX_CONFIRMATION_CLARIFICATION_ATTEMPTS = 1;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function stripConversationalCorrectionFraming(speech: string): string {
  let trimmed = speech.trim();

  for (const pattern of CONVERSATIONAL_PREFIXES) {
    trimmed = trimmed.replace(pattern, "").trim();
  }

  trimmed = trimmed
    .replace(/\s+to the (?:service )?(?:address|phone(?: number)?)\.?$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();

  return trimmed;
}

export function resolveCorrectionTargetField(
  activeField: ConfirmableFieldKey,
  speech: string,
): ConfirmableFieldKey {
  const lower = speech.toLowerCase();

  if (
    /\b(phone|number|callback)\b/i.test(lower) &&
    /\b(last digit|ends in|area code|middle three|cell|mobile)\b/i.test(lower)
  ) {
    return "callback_phone";
  }

  if (/\b(address|street|apartment|apt\.?|unit|zip)\b/i.test(lower)) {
    return "address";
  }

  return activeField;
}

function insertUnitIntoAddress(current: string, unitText: string): string {
  const unit = unitText.replace(/^(apartment|apt\.?|unit|suite|#)\s+/i, "").trim();
  const formattedUnit = /^(apartment|apt\.?|unit|suite|#)/i.test(unitText)
    ? unitText.replace(/\s+/g, " ").trim()
    : `Apartment ${unit}`;

  const parts = current
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return [parts[0], formattedUnit, ...parts.slice(1)].join(", ");
  }

  return appendToAddress(current, formattedUnit);
}

export function attachFieldConfirmationContext(
  fields: RealtimeFields,
  field: ConfirmableFieldKey,
  value: string,
): RealtimeFields {
  return {
    ...fields,
    field_being_confirmed: field,
    activeConfirmationField: field,
    current_field_value: value,
    activeConfirmationValue: value,
    confirmation_attempt_count: fields.confirmation_attempt_count ?? 0,
    correctionAttemptCount: fields.correctionAttemptCount ?? fields.confirmation_attempt_count ?? 0,
    confirmationStatus: fields.confirmationStatus ?? "pending",
  };
}

export function clearFieldConfirmationContext(fields: RealtimeFields): RealtimeFields {
  return {
    ...fields,
    field_being_confirmed: undefined,
    activeConfirmationField: undefined,
    current_field_value: undefined,
    activeConfirmationValue: undefined,
    confirmation_attempt_count: undefined,
    correctionAttemptCount: undefined,
    confirmationStatus: undefined,
    confirmation_last_outcome: undefined,
    pending_correction_hint: undefined,
  };
}

export function getActiveConfirmationField(
  fields: RealtimeFields,
  fallback?: ConfirmableFieldKey,
): ConfirmableFieldKey | null {
  const stored = fields.field_being_confirmed?.trim();

  if (
    stored === "callback_phone" ||
    stored === "address" ||
    stored === "full_name" ||
    stored === "appointment_preference"
  ) {
    return stored;
  }

  return fallback ?? null;
}

function getConfirmationClarificationAttempts(
  fields: RealtimeFields,
  field: ConfirmableFieldKey,
): number {
  return fields.field_clarification_attempts?.[field] ?? 0;
}

function incrementConfirmationClarificationAttempts(
  fields: RealtimeFields,
  field: ConfirmableFieldKey,
): RealtimeFields {
  const attempts = getConfirmationClarificationAttempts(fields, field) + 1;

  return {
    ...fields,
    field_clarification_attempts: {
      ...(fields.field_clarification_attempts ?? {}),
      [field]: attempts,
    },
  };
}

function buildCorrectedFieldReadback(field: ConfirmableFieldKey, value: string): string {
  switch (field) {
    case "callback_phone":
      return `Got it. I now have your callback number as ${formatCallbackForSpeech(value)}. Is that correct?`;
    case "address":
      return `Got it. I now have your service address as ${formatAddressForSpeech(sanitizeAddressValue(value))}. Is that correct?`;
    case "full_name":
      return `Got it. I now have your name as ${value.trim()}. Is that correct?`;
    case "appointment_preference":
      return `Got it. I now have ${value.trim()}. Is that correct?`;
  }
}

function buildAmbiguousCorrectionPrompt(field: ConfirmableFieldKey, hint: string): string {
  switch (field) {
    case "address":
      return `Just to make sure, should I ${hint}?`;
    case "callback_phone":
      return `Just to make sure, should I ${hint}?`;
    default:
      return `Just to make sure, ${hint}?`;
  }
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function spokenDigitToChar(token: string): string | null {
  const normalized = token.trim().toLowerCase();

  if (/^\d$/.test(normalized)) {
    return normalized;
  }

  const map: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };

  return map[normalized] ?? null;
}

function applyPhonePartialEdit(currentPhone: string, speech: string, callerPhone?: string): string | null {
  const digits = phoneDigits(currentPhone);

  if (digits.length !== 10) {
    return extractCallbackPhoneFromSpeech(speech, callerPhone);
  }

  const extracted = extractCallbackPhoneFromSpeech(speech, callerPhone);
  if (extracted && !isCompanyPhoneNumber(extracted)) {
    return normalizeCallbackPhoneE164(extracted);
  }

  const lastDigitMatch = speech.match(
    /\blast digit (?:should be|is)\s+(\d|zero|one|two|three|four|five|six|seven|eight|nine)\b/i,
  );
  if (lastDigitMatch?.[1]) {
    const digit = spokenDigitToChar(lastDigitMatch[1]);
    if (digit) {
      return normalizeCallbackPhoneE164(`${digits.slice(0, 9)}${digit}`);
    }
  }

  const areaCodeMatch = speech.match(/\bstarts with (\d{3}), not (\d{3})\b/i);
  if (areaCodeMatch?.[1]) {
    return normalizeCallbackPhoneE164(`${areaCodeMatch[1]}${digits.slice(3)}`);
  }

  const middleMatch = speech.match(/\bmiddle three digits are (\d{3})\b/i);
  if (middleMatch?.[1]) {
    return normalizeCallbackPhoneE164(`${digits.slice(0, 3)}${middleMatch[1]}${digits.slice(6)}`);
  }

  if (/\b(use my cell|use my mobile|different number|another number)\b/i.test(speech) && callerPhone) {
    const normalized = normalizeCallbackPhoneE164(callerPhone);
    if (!isCompanyPhoneNumber(normalized)) {
      return normalized;
    }
  }

  return null;
}

function appendToAddress(current: string, suffix: string): string {
  const trimmedSuffix = suffix.trim();

  if (!trimmedSuffix) {
    return current;
  }

  if (/^[,.\s]/.test(trimmedSuffix) || /^(apartment|apt\.?|unit|suite|#)\b/i.test(trimmedSuffix)) {
    return `${current.replace(/[,\s]+$/, "")}, ${trimmedSuffix.replace(/^,+\s*/, "")}`.trim();
  }

  return `${current.replace(/[,\s]+$/, "")} ${trimmedSuffix}`.replace(/\s+/g, " ").trim();
}

function applyAddressPartialEdit(currentAddress: string, speech: string): string | null {
  const structured = parseAddressStructuredCorrection(currentAddress, speech);
  if (structured?.requiresClarification) {
    return null;
  }
  if (structured) {
    return applyStructuredCorrectionToAddress(currentAddress, structured);
  }

  return null;
}

export function parseAddressStructuredCorrection(
  currentAddress: string,
  speech: string,
): StructuredFieldCorrection | null {
  const cleaned = stripConversationalCorrectionFraming(speech);
  const current = sanitizeAddressValue(currentAddress);

  const extracted = extractAddressFromSpeech(cleaned);
  if (
    extracted &&
    isPlausibleServiceAddress(extracted) &&
    !/^add\b/i.test(cleaned) &&
    extracted.replace(/\s+/g, " ").trim() !== current.replace(/\s+/g, " ").trim()
  ) {
    return {
      targetField: "address",
      operation: "replace_full_value",
      replacementValue: sanitizeAddressValue(extracted),
      confidence: "high",
      requiresClarification: false,
    };
  }

  const apartmentMatch = cleaned.match(/\badd (?:apartment|apt\.?|unit)\s+([A-Za-z0-9-]+)\b/i);
  if (apartmentMatch?.[1]) {
    return {
      targetField: "address",
      operation: "replace_unit",
      fragmentToAdd: `Apartment ${apartmentMatch[1]}`,
      confidence: "high",
      requiresClarification: false,
    };
  }

  const appendEndMatch = cleaned.match(/\badd (?:an? )?(.+?) (?:at )?(?:the )?end\b/i);
  if (appendEndMatch?.[1]) {
    const suffix = appendEndMatch[1].trim();
    if (/^i$/i.test(suffix)) {
      return {
        targetField: "address",
        operation: "append",
        fragmentToAdd: "I",
        confidence: "low",
        requiresClarification: true,
        clarificationHint: "add the letter I to the end of the address",
      };
    }
    return {
      targetField: "address",
      operation: "append",
      fragmentToAdd: suffix,
      confidence: "high",
      requiresClarification: false,
    };
  }

  const genericAddMatch = cleaned.match(/^add (.+)$/i);
  if (genericAddMatch?.[1] && !/\b(at|to) the end\b/i.test(cleaned)) {
    const fragment = genericAddMatch[1].trim();
    if (/^(apartment|apt\.?|unit)\s+[A-Za-z0-9-]+$/i.test(fragment)) {
      return {
        targetField: "address",
        operation: "replace_unit",
        fragmentToAdd: fragment.replace(/^(apartment|apt\.?|unit)\s+/i, "Apartment "),
        confidence: "high",
        requiresClarification: false,
      };
    }

    return {
      targetField: "address",
      operation: "append",
      fragmentToAdd: fragment,
      confidence: "high",
      requiresClarification: false,
    };
  }

  if (/\bremove (?:the )?(?:apartment|apt\.?|unit)(?:\s+number)?\b/i.test(cleaned)) {
    return {
      targetField: "address",
      operation: "remove",
      fragmentToRemove: "unit",
      confidence: "high",
      requiresClarification: false,
    };
  }

  const directionMatch = cleaned.match(/\b(north|south|east|west)\b.+?\bnot\b\s+(north|south|east|west)\b/i);
  if (directionMatch?.[1] && directionMatch?.[2]) {
    return {
      targetField: "address",
      operation: "replace_street_direction",
      fragmentToReplace: directionMatch[2],
      replacementValue: directionMatch[1],
      confidence: "high",
      requiresClarification: false,
    };
  }

  const replaceMatch = cleaned.match(/\b([A-Za-z0-9][A-Za-z0-9\s-]{1,30}), not ([A-Za-z0-9][A-Za-z0-9\s-]{1,30})\b/i);
  if (replaceMatch?.[1] && replaceMatch?.[2]) {
    return {
      targetField: "address",
      operation: "replace_fragment",
      fragmentToReplace: replaceMatch[2].trim(),
      replacementValue: replaceMatch[1].trim(),
      confidence: "high",
      requiresClarification: false,
    };
  }

  const zipMatch = cleaned.match(/\b(?:zip|zip code) (?:is )?(\d{5}(?:-\d{4})?)\b/i);
  if (zipMatch?.[1]) {
    return {
      targetField: "address",
      operation: "replace_zip",
      replacementValue: zipMatch[1],
      confidence: "high",
      requiresClarification: false,
    };
  }

  return null;
}

function applyStructuredCorrectionToAddress(
  currentAddress: string,
  correction: StructuredFieldCorrection,
): string {
  const current = sanitizeAddressValue(currentAddress);

  switch (correction.operation) {
    case "replace_full_value":
      return sanitizeAddressValue(correction.replacementValue ?? current);
    case "replace_unit":
      return sanitizeAddressValue(
        insertUnitIntoAddress(current, correction.fragmentToAdd ?? correction.replacementValue ?? ""),
      );
    case "append":
      if (correction.fragmentToAdd && /^(apartment|apt\.?|unit)\s+/i.test(correction.fragmentToAdd)) {
        return sanitizeAddressValue(insertUnitIntoAddress(current, correction.fragmentToAdd));
      }
      return sanitizeAddressValue(appendToAddress(current, correction.fragmentToAdd ?? ""));
    case "remove":
      return current
        .replace(/,?\s*(?:apartment|apt\.?|unit|suite|#)\s*[A-Za-z0-9-]+/i, "")
        .replace(/\s+/g, " ")
        .trim();
    case "replace_street_direction":
      return current.replace(
        new RegExp(correction.fragmentToReplace ?? "", "i"),
        correction.replacementValue ?? "",
      );
    case "replace_fragment":
      return current.replace(
        new RegExp(correction.fragmentToReplace ?? "", "i"),
        correction.replacementValue ?? "",
      );
    case "replace_zip": {
      const withoutZip = current.replace(/,?\s*\b\d{5}(?:-\d{4})?\b/, "").trim();
      return `${withoutZip}, ${correction.replacementValue}`.replace(/\s+/g, " ").trim();
    }
    default:
      return current;
  }
}

function parsePhoneStructuredCorrection(
  currentPhone: string,
  speech: string,
  callerPhone?: string,
): StructuredFieldCorrection | null {
  const cleaned = stripConversationalCorrectionFraming(speech);
  const digits = phoneDigits(currentPhone);

  const extracted = extractCallbackPhoneFromSpeech(cleaned, callerPhone);
  if (extracted && !isCompanyPhoneNumber(extracted) && phoneDigits(extracted) !== digits) {
    return {
      targetField: "callback_phone",
      operation: "replace_full_value",
      replacementValue: normalizeCallbackPhoneE164(extracted),
      confidence: "high",
      requiresClarification: false,
    };
  }

  const lastDigitMatch = cleaned.match(
    /\b(?:the )?last digit (?:should be|is)\s+(\d|zero|one|two|three|four|five|six|seven|eight|nine)\b/i,
  );
  if (lastDigitMatch?.[1] && digits.length === 10) {
    const digit = spokenDigitToChar(lastDigitMatch[1]);
    if (digit) {
      return {
        targetField: "callback_phone",
        operation: "replace_digit",
        replacementValue: digit,
        confidence: "high",
        requiresClarification: false,
      };
    }
  }

  const endsInMatch = cleaned.match(
    /\b(?:phone|number)?\s*(?:ends in|end in)\s+(\d|zero|one|two|three|four|five|six|seven|eight|nine)\b/i,
  );
  if (endsInMatch?.[1] && digits.length === 10) {
    const digit = spokenDigitToChar(endsInMatch[1]);
    if (digit) {
      return {
        targetField: "callback_phone",
        operation: "replace_digit",
        replacementValue: digit,
        confidence: "high",
        requiresClarification: false,
      };
    }
  }

  const areaCodeMatch = cleaned.match(/\bstarts with (\d{3}), not (\d{3})\b/i);
  if (areaCodeMatch?.[1] && digits.length === 10) {
    return {
      targetField: "callback_phone",
      operation: "replace_fragment",
      fragmentToReplace: digits.slice(0, 3),
      replacementValue: areaCodeMatch[1],
      confidence: "high",
      requiresClarification: false,
    };
  }

  const middleMatch = cleaned.match(/\bmiddle three digits are (\d{3})\b/i);
  if (middleMatch?.[1] && digits.length === 10) {
    return {
      targetField: "callback_phone",
      operation: "replace_fragment",
      fragmentToReplace: digits.slice(3, 6),
      replacementValue: middleMatch[1],
      confidence: "high",
      requiresClarification: false,
    };
  }

  if (/\b(use my cell|use my mobile|different number|another number)\b/i.test(cleaned) && callerPhone) {
    return {
      targetField: "callback_phone",
      operation: "replace_full_value",
      replacementValue: normalizeCallbackPhoneE164(callerPhone),
      confidence: "medium",
      requiresClarification: false,
    };
  }

  return null;
}

function applyStructuredCorrectionToPhone(
  currentPhone: string,
  correction: StructuredFieldCorrection,
): string {
  const digits = phoneDigits(currentPhone);

  switch (correction.operation) {
    case "replace_full_value":
      return normalizeCallbackPhoneE164(correction.replacementValue ?? currentPhone);
    case "replace_digit":
      if (digits.length === 10 && correction.replacementValue) {
        return normalizeCallbackPhoneE164(`${digits.slice(0, 9)}${correction.replacementValue}`);
      }
      return currentPhone;
    case "replace_fragment":
      if (digits.length === 10 && correction.fragmentToReplace && correction.replacementValue) {
        return normalizeCallbackPhoneE164(
          digits.replace(correction.fragmentToReplace, correction.replacementValue),
        );
      }
      return currentPhone;
    default:
      return currentPhone;
  }
}

function detectAmbiguousAddressEdit(speech: string): string | null {
  const structured = parseAddressStructuredCorrection("", speech);
  if (structured?.requiresClarification) {
    return structured.clarificationHint ?? null;
  }

  return null;
}

function applyScopedCorrectionToField(
  fields: RealtimeFields,
  speech: string,
  activeField: ConfirmableFieldKey,
  callerPhone?: string,
): { updated: RealtimeFields; valueChanged: boolean; ambiguousHint?: string } {
  const targetField = resolveCorrectionTargetField(activeField, speech);
  const cleaned = stripConversationalCorrectionFraming(speech);
  let updated = { ...fields };
  let valueChanged = false;
  let ambiguousHint: string | undefined;

  switch (targetField) {
    case "callback_phone": {
      const current = fields.callback_phone ?? fields.current_field_value ?? "";
      const structured = parsePhoneStructuredCorrection(current, cleaned, callerPhone);

      if (structured?.requiresClarification) {
        ambiguousHint = structured.clarificationHint;
        break;
      }

      if (structured) {
        const nextPhone = applyStructuredCorrectionToPhone(current, structured);
        if (nextPhone && nextPhone !== current) {
          updated = syncLegacyStringFields({
            ...updated,
            callback_phone: nextPhone,
            callback_phone_confirmed: false,
          });
          valueChanged = true;
        }
      }
      break;
    }
    case "address": {
      const current = fields.address ?? fields.current_field_value ?? "";
      const structured = parseAddressStructuredCorrection(current, cleaned);

      if (structured?.requiresClarification) {
        ambiguousHint = structured.clarificationHint;
        break;
      }

      if (structured) {
        const nextAddress = applyStructuredCorrectionToAddress(current, structured);
        if (nextAddress && nextAddress !== sanitizeAddressValue(current)) {
          updated = syncLegacyStringFields({
            ...updated,
            address: sanitizeAddressValue(nextAddress).slice(0, 500),
            address_confirmed: false,
          });
          valueChanged = true;
        }
      }
      break;
    }
    case "full_name": {
      const nameMatch = cleaned.match(
        /(?:name is|call me|it's|it is)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i,
      );
      if (nameMatch?.[1]) {
        updated = syncLegacyStringFields({
          ...updated,
          full_name: nameMatch[1].trim(),
        });
        valueChanged = true;
      }
      break;
    }
    case "appointment_preference": {
      if (hasValue(cleaned) && cleaned.length >= 3) {
        updated = syncLegacyStringFields({
          ...updated,
          appointment_preference_raw: cleaned.slice(0, 200),
          schedule_confirmed: false,
        });
        valueChanged = true;
      }
      break;
    }
  }

  if (valueChanged) {
    updated = attachFieldConfirmationContext(
      updated,
      targetField,
      readFieldValue(updated, targetField),
    );
    updated.confirmation_last_outcome = "corrected";
  }

  return { updated, valueChanged, ambiguousHint };
}

function readFieldValue(fields: RealtimeFields, field: ConfirmableFieldKey): string {
  switch (field) {
    case "callback_phone":
      return fields.callback_phone ?? "";
    case "address":
      return fields.address ?? "";
    case "full_name":
      return fields.full_name ?? "";
    case "appointment_preference":
      return fields.appointment_preference_raw ?? fields.appointment_preference ?? "";
  }
}

export function processFieldConfirmationResponse(input: {
  fields: RealtimeFields;
  speech: string;
  activeField: ConfirmableFieldKey;
  callerPhone?: string;
  isConfirmed: boolean;
  isRejected: boolean;
}): FieldConfirmationResult {
  const { fields, speech, activeField, callerPhone, isConfirmed, isRejected } = input;
  const trimmed = speech.trim();

  if (
    activeField === "address" &&
    fields.pending_correction_hint &&
    /^(yes|yeah|yep|yup|correct|right)\b/i.test(trimmed)
  ) {
    const current = readFieldValue(fields, activeField);
    const nextAddress =
      fields.pending_correction_hint === "append_i"
        ? `${current}I`
        : applyAddressPartialEdit(current, fields.pending_correction_hint) ?? current;

    if (nextAddress !== current) {
      const updated = syncLegacyStringFields({
        ...attachFieldConfirmationContext(fields, activeField, nextAddress),
        address: sanitizeAddressValue(nextAddress).slice(0, 500),
        address_confirmed: false,
        pending_correction_hint: undefined,
        confirmation_last_outcome: "corrected",
      });

      return {
        fields: updated,
        outcome: "corrected",
        replyText: buildCorrectedFieldReadback(activeField, nextAddress),
        updated: true,
      };
    }
  }

  if (isConfirmed) {
    return {
      fields: clearFieldConfirmationContext({
        ...fields,
        confirmation_last_outcome: "accepted",
      }),
      outcome: "accepted",
      updated: false,
    };
  }

  if (!trimmed || isRejected) {
    return {
      fields: attachFieldConfirmationContext(
        { ...fields, confirmation_last_outcome: "rejected" },
        activeField,
        readFieldValue(fields, activeField),
      ),
      outcome: "rejected",
      updated: false,
    };
  }

  const correction = applyScopedCorrectionToField(fields, trimmed, activeField, callerPhone);

  if (correction.valueChanged) {
    const value = readFieldValue(correction.updated, activeField);
    return {
      fields: correction.updated,
      outcome: "corrected",
      replyText: buildCorrectedFieldReadback(activeField, value),
      updated: true,
    };
  }

  if (correction.ambiguousHint) {
    const attempts = getConfirmationClarificationAttempts(fields, activeField);

    if (attempts >= MAX_CONFIRMATION_CLARIFICATION_ATTEMPTS) {
      const notes = fields.additional_notes?.trim();
      const combined = notes
        ? `${notes} Unresolved ${activeField} correction: ${trimmed.slice(0, 120)}`
        : `Unresolved ${activeField} correction: ${trimmed.slice(0, 120)}`;

      return {
        fields: syncLegacyStringFields({
          ...attachFieldConfirmationContext(fields, activeField, readFieldValue(fields, activeField)),
          additional_notes: combined.slice(0, 500),
          confirmation_last_outcome: "unchanged",
        }),
        outcome: "unchanged",
        replyText:
          activeField === "address"
            ? buildAddressConfirmationReplyFromFields({
                ...fields,
                address: readFieldValue(fields, activeField),
              })
            : buildPhoneConfirmationReplyFromFields({
                ...fields,
                callback_phone: readFieldValue(fields, activeField),
              }),
        updated: false,
      };
    }

    return {
      fields: incrementConfirmationClarificationAttempts(
        {
          ...attachFieldConfirmationContext(fields, activeField, readFieldValue(fields, activeField)),
          pending_correction_hint:
            correction.ambiguousHint === "add the letter I to the end of the address"
              ? "append_i"
              : correction.ambiguousHint,
        },
        activeField,
      ),
      outcome: "needs_clarification",
      replyText: buildAmbiguousCorrectionPrompt(activeField, correction.ambiguousHint),
      updated: false,
    };
  }

  return {
    fields: attachFieldConfirmationContext(fields, activeField, readFieldValue(fields, activeField)),
    outcome: "unchanged",
    updated: false,
  };
}

export function applyAddressScopedCorrection(
  fields: RealtimeFields,
  speech: string,
): FieldConfirmationResult {
  return processFieldConfirmationResponse({
    fields: attachFieldConfirmationContext(
      fields,
      "address",
      fields.address ?? "",
    ),
    speech,
    activeField: "address",
    isConfirmed: false,
    isRejected: false,
  });
}

export function applyCallbackScopedCorrection(
  fields: RealtimeFields,
  speech: string,
  callerPhone?: string,
): FieldConfirmationResult {
  return processFieldConfirmationResponse({
    fields: attachFieldConfirmationContext(
      fields,
      "callback_phone",
      fields.callback_phone ?? "",
    ),
    speech,
    activeField: "callback_phone",
    callerPhone,
    isConfirmed: false,
    isRejected: false,
  });
}

export function addressConfirmationExcludesPhone(reply: string, phone?: string): boolean {
  if (!phone) {
    return !/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/.test(reply);
  }

  const spoken = formatCallbackForSpeech(phone);
  return !reply.includes(spoken) && !reply.includes(phone.replace(/\D/g, "").slice(-10));
}

export function callbackConfirmationExcludesAddress(reply: string, address?: string): boolean {
  if (!address?.trim()) {
    return true;
  }

  const normalizedAddress = formatAddressForSpeech(address);
  return !reply.includes(normalizedAddress);
}

export function hasConfirmableAddressValue(fields: RealtimeFields): boolean {
  return hasConfirmableAddress(sanitizeAddressValue(fields.address ?? ""));
}
