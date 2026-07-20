import { formatCallbackForSpeech } from "./callback-phone.js";
import {
  isPlausibleCallerName,
  isPlausibleServiceAddress,
} from "./field-validation.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export type SummaryData = {
  name: string | null;
  phone: string | null;
  address: string | null;
  reason: string | null;
  damage: string | null;
  urgency: string | null;
  leak: boolean | null;
  insurance: boolean | null;
  adjuster: boolean | null;
  photos: boolean | null;
  callbackPreference: string | null;
  notes: string | null;
};

export type SummaryValidationIssue =
  | "invalid_name"
  | "invalid_phone"
  | "invalid_address"
  | "missing_reason";

export function buildSummaryDataObject(fields: RealtimeFields): SummaryData {
  const name = fields.full_name?.trim() ?? null;
  const phone = fields.callback_phone?.trim() ?? null;
  const address = fields.address?.trim() ?? null;

  return {
    name: name && isPlausibleCallerName(name) ? name : null,
    phone: phone && fields.callback_phone_confirmed === true ? phone : null,
    address:
      address && isPlausibleServiceAddress(address) ? address : null,
    reason: fields.problem_description?.trim() ?? null,
    damage: fields.problem_description?.trim() ?? null,
    urgency: fields.urgency?.trim() ?? null,
    leak:
      fields.emergency_or_active_leak === true || fields.emergency_or_active_leak === false
        ? fields.emergency_or_active_leak
        : null,
    insurance:
      fields.insurance_claim_started === true || fields.insurance_claim_started === false
        ? fields.insurance_claim_started
        : null,
    adjuster:
      fields.adjuster_contacted === true || fields.adjuster_contacted === false
        ? fields.adjuster_contacted
        : null,
    photos:
      fields.photos_available === true || fields.photos_available === false
        ? fields.photos_available
        : null,
    callbackPreference: fields.appointment_preference?.trim() ?? null,
    notes: fields.additional_notes?.trim() ?? null,
  };
}

export function validateSummaryData(
  data: SummaryData,
  fields: RealtimeFields,
): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];

  if (fields.full_name?.trim() && !isPlausibleCallerName(fields.full_name)) {
    issues.push("invalid_name");
  }

  if (data.address && !isPlausibleServiceAddress(data.address)) {
    issues.push("invalid_address");
  }

  if (!data.reason && !data.damage) {
    issues.push("missing_reason");
  }

  return issues;
}

export function buildValidatedSpokenSummary(fields: RealtimeFields): {
  summary: string;
  issues: SummaryValidationIssue[];
} {
  const data = buildSummaryDataObject(fields);
  const issues = validateSummaryData(data, fields);

  if (issues.includes("invalid_name")) {
    return { summary: "", issues };
  }

  const detailParts: string[] = [];

  if (data.name) {
    detailParts.push(`Your name is ${data.name}`);
  }

  if (data.phone) {
    detailParts.push(`your callback number is ${formatCallbackForSpeech(data.phone)}`);
  }

  if (data.address) {
    detailParts.push(`the property is at ${data.address}`);
  }

  const situationParts: string[] = [];

  if (data.damage) {
    situationParts.push(`you're calling about ${data.damage.replace(/\.$/, "")}`);
  }

  if (data.leak === true) {
    situationParts.push("there is active water intrusion");
  } else if (data.leak === false) {
    situationParts.push("there isn't an active leak");
  }

  if (data.insurance === true) {
    situationParts.push(
      data.adjuster === true
        ? "you've started an insurance claim and contacted your adjuster"
        : data.adjuster === false
          ? "you've started an insurance claim but haven't contacted your adjuster yet"
          : "you've started an insurance claim",
    );
  } else if (data.insurance === false) {
    situationParts.push("you haven't started an insurance claim yet");
  }

  if (data.photos === true) {
    situationParts.push("you have photos available");
  } else if (data.photos === false) {
    situationParts.push("you don't have photos yet");
  }

  if (data.callbackPreference) {
    situationParts.push(`you'd prefer a call on ${data.callbackPreference.replace(/\.$/, "")}`);
  }

  if (data.notes) {
    situationParts.push(`I also noted ${data.notes.replace(/\.$/, "")}`);
  }

  const sentences = ["Here's what I have."];

  if (detailParts.length > 0) {
    sentences.push(`${detailParts.join(", ")}.`);
  }

  if (situationParts.length > 0) {
    const joined = situationParts.map((part) => part.replace(/\.$/, "")).join(", ");
    sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
  }

  return {
    summary: sentences.join(" "),
    issues,
  };
}
