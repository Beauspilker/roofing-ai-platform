import type { CollectedFields } from "../../../../lib/call-intake.js";
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

export type RealtimeFields = CollectedFields & {
  insurance_claim_started?: TriStateBoolean;
  adjuster_contacted?: TriStateBoolean;
  photos_available?: TriStateBoolean;
  emergency_or_active_leak?: TriStateBoolean;
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

export function buildStructuredSpokenSummary(fields: RealtimeFields): string {
  const parts: string[] = [];

  if (fields.problem_description?.trim()) {
    parts.push(`You're calling about ${fields.problem_description.trim()}.`);
  }

  if (fields.full_name?.trim()) {
    parts.push(`I have you as ${fields.full_name.trim()}.`);
  }

  if (fields.callback_phone?.trim()) {
    parts.push(`The best callback number is ${fields.callback_phone.trim()}.`);
  }

  if (fields.address?.trim()) {
    parts.push(`The property is at ${fields.address.trim()}.`);
  }

  if (fields.project_type?.trim()) {
    parts.push(`This looks like a ${fields.project_type.trim()} project.`);
  }

  parts.push(
    booleanFieldSpokenLine(
      "emergency_or_active_leak",
      fields.emergency_or_active_leak ?? null,
    ),
  );
  parts.push(
    booleanFieldSpokenLine(
      "insurance_claim_started",
      fields.insurance_claim_started ?? null,
    ),
  );

  if (fields.insurance_claim_started === true) {
    parts.push(
      booleanFieldSpokenLine("adjuster_contacted", fields.adjuster_contacted ?? null),
    );
  }

  parts.push(
    booleanFieldSpokenLine("photos_available", fields.photos_available ?? null),
  );

  if (fields.urgency?.trim()) {
    parts.push(`Timing is ${fields.urgency.trim()}.`);
  }

  if (fields.appointment_preference?.trim()) {
    parts.push(`You'd prefer ${fields.appointment_preference.trim()}.`);
  }

  if (fields.additional_notes?.trim()) {
    parts.push(`I also noted ${fields.additional_notes.trim()}.`);
  }

  const filtered = parts.map((part) => part.trim()).filter(Boolean);

  if (filtered.length === 0) {
    return "Here's what I have so far.";
  }

  return filtered.join(" ");
}

export function buildSummaryWithConfirmation(fields: RealtimeFields): string {
  return `${buildStructuredSpokenSummary(fields)} Does all of that sound correct?`;
}

export function buildCorrectionAcknowledgement(
  field: StructuredBooleanField,
  value: TriStateBoolean,
): string {
  return `${booleanFieldSpokenLine(field, value)} Does that sound correct now?`;
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
