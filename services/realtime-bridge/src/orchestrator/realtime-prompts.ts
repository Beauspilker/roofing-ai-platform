import type { CollectedFields } from "../../../../lib/call-intake.js";
import { formatCallbackForSpeech } from "./callback-phone.js";
import {
  booleanFieldSpokenLine,
  type StructuredBooleanField,
  type TriStateBoolean,
} from "./structured-intake.js";
import { CLOSING_MESSAGE } from "./conversation-state.js";

export const REALTIME_OPENING_GREETING =
  "Thanks for calling Beau's Roofing. How can I help you today?";

export const REALTIME_OPENING_QUESTION = "How can I help you today?";

export const REALTIME_ANYTHING_ELSE_QUESTION =
  "Is there anything else you'd like the roofing team to know?";

export type RealtimeFields = Omit<
  CollectedFields,
  "insurance_claim" | "adjuster_contacted" | "photos_available" | "active_leak"
> & {
  insurance_claim_started?: TriStateBoolean;
  adjuster_contacted?: TriStateBoolean;
  photos_available?: TriStateBoolean;
  emergency_or_active_leak?: TriStateBoolean;
  callback_phone_confirmed?: boolean;
  insurance_claim?: string;
  adjuster_contacted_legacy?: string;
  photos_available_legacy?: string;
  active_leak?: string;
};

export function ensureSingleIntakeQuestion(text: string): string {
  const trimmed = text.trim();

  if (!trimmed) {
    return trimmed;
  }

  const questionIndexes: number[] = [];

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "?") {
      questionIndexes.push(index);
    }
  }

  if (questionIndexes.length <= 1) {
    return trimmed;
  }

  const firstQuestionEnd = questionIndexes[0] + 1;
  return trimmed.slice(0, firstQuestionEnd).trim();
}

export function buildRealtimeIntakeReply(
  prefix: string | null,
  question: string,
): string {
  const trimmedQuestion = question.trim();

  if (!prefix) {
    return ensureSingleIntakeQuestion(trimmedQuestion);
  }

  return ensureSingleIntakeQuestion(
    `${prefix} ${trimmedQuestion}`.replace(/\s+/g, " ").trim(),
  );
}

function spokenCallbackNumber(fields: RealtimeFields): string | null {
  if (!fields.callback_phone?.trim()) {
    return null;
  }

  return formatCallbackForSpeech(fields.callback_phone);
}

function spokenInsuranceSummary(fields: RealtimeFields): string {
  if (fields.insurance_claim_started === true) {
    const adjuster =
      fields.adjuster_contacted === true
        ? "and you've contacted your adjuster"
        : fields.adjuster_contacted === false
          ? "but you haven't contacted your adjuster yet"
          : "";
    return `you've started an insurance claim${adjuster ? ` ${adjuster}` : ""}`.trim();
  }

  if (fields.insurance_claim_started === false) {
    const adjuster =
      fields.adjuster_contacted === false
        ? " and you haven't contacted an adjuster yet"
        : "";
    return `you haven't started an insurance claim${adjuster}`.trim();
  }

  return booleanFieldSpokenLine("insurance_claim_started", null).replace(/\.$/, "").toLowerCase();
}

function spokenLeakSummary(fields: RealtimeFields): string | null {
  if (fields.emergency_or_active_leak === true) {
    return "there is active water intrusion";
  }

  if (fields.emergency_or_active_leak === false) {
    return "there isn't an active leak";
  }

  return null;
}

function spokenPhotosSummary(fields: RealtimeFields): string | null {
  if (fields.photos_available === true) {
    return "you have photos available";
  }

  if (fields.photos_available === false) {
    return "you don't have photos yet";
  }

  return null;
}

export function buildStructuredSpokenSummary(fields: RealtimeFields): string {
  const sentences: string[] = ["Let me make sure I have everything right."];

  const detailParts: string[] = [];

  if (fields.full_name?.trim()) {
    detailParts.push(`Your name is ${fields.full_name.trim()}`);
  }

  const callback = spokenCallbackNumber(fields);
  if (callback) {
    detailParts.push(`your callback number is ${callback}`);
  }

  if (fields.address?.trim()) {
    detailParts.push(`the property is at ${fields.address.trim()}`);
  }

  if (detailParts.length > 0) {
    sentences.push(`${detailParts.join(", ")}.`);
  }

  const situationParts: string[] = [];

  if (fields.problem_description?.trim()) {
    situationParts.push(fields.problem_description.trim());
  }

  if (fields.project_type?.trim()) {
    situationParts.push(`this is a ${fields.project_type.trim()} project`);
  }

  const leak = spokenLeakSummary(fields);
  if (leak) {
    situationParts.push(leak);
  }

  if (fields.storm_damage?.trim()) {
    situationParts.push(
      fields.storm_damage.toLowerCase() === "yes" ? "storm damage was reported" : "no storm damage noted",
    );
  }

  const insurance = spokenInsuranceSummary(fields);
  if (insurance) {
    situationParts.push(insurance);
  }

  if (fields.urgency?.trim()) {
    situationParts.push(`timing is ${fields.urgency.trim()}`);
  }

  if (fields.appointment_preference?.trim()) {
    situationParts.push(`you'd prefer ${fields.appointment_preference.trim()}`);
  }

  const photos = spokenPhotosSummary(fields);
  if (photos) {
    situationParts.push(photos);
  }

  if (fields.additional_notes?.trim()) {
    situationParts.push(`I also noted ${fields.additional_notes.trim()}`);
  }

  if (situationParts.length > 0) {
    const joined = situationParts
      .map((part) => part.replace(/\.$/, ""))
      .join(", ");
    sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
  }

  if (sentences.length === 1) {
    return "Let me make sure I have everything right.";
  }

  return sentences.join(" ");
}

export function buildSummaryWithConfirmation(fields: RealtimeFields): string {
  return `${buildStructuredSpokenSummary(fields)} Does all of that sound correct?`;
}

export function buildClosingMessage(): string {
  return CLOSING_MESSAGE;
}

export function isAnythingElseDeclined(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /^(no|nope|nah|nothing|none|that's all|thats all|that is all|i'm good|im good|all set|nothing else)\b/.test(
      normalized,
    ) || normalized.includes("nothing else")
  );
}

export function isSummaryConfirmed(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|sounds good|all good|perfect)\b/.test(
    normalized,
  );
}

export function isSummaryRejected(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

export function summaryContainsKnownFields(fields: RealtimeFields): boolean {
  return Boolean(
    fields.full_name ||
      fields.callback_phone ||
      fields.address ||
      fields.problem_description ||
      fields.insurance_claim_started !== undefined,
  );
}
