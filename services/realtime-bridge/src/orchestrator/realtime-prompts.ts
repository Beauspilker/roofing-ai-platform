import type { CollectedFields } from "../../../../lib/call-intake.js";
import { formatCallbackForSpeech } from "./callback-phone.js";
import {
  booleanFieldSpokenLine,
  type StructuredBooleanField,
  type TriStateBoolean,
} from "./structured-intake.js";
import { CLOSING_MESSAGE } from "./conversation-state.js";
import type { PhotosAvailability } from "./photos-field.js";
import { buildValidatedSpokenSummary } from "./summary-builder.js";

export const REALTIME_OPENING_GREETING =
  "Thank you for calling Beau's Roofing. I'm Beau's Roofing's AI assistant.";

export const REALTIME_OPENING_NAME_QUESTION =
  "Could I start with your first and last name?";

export const REALTIME_INTRO_TRANSITION = "";

export const REALTIME_OPENING_QUESTION = REALTIME_OPENING_NAME_QUESTION;

export const REALTIME_ANYTHING_ELSE_QUESTION =
  "Is there anything else you'd like the roofing team to know?";

export type RealtimeFields = Omit<
  CollectedFields,
  "insurance_claim" | "adjuster_contacted" | "photos_available" | "active_leak"
> & {
  insurance_claim_started?: TriStateBoolean;
  adjuster_contacted?: TriStateBoolean;
  photos_available?: PhotosAvailability;
  emergency_or_active_leak?: TriStateBoolean;
  callback_phone_confirmed?: boolean;
  address_confirmed?: boolean;
  appointment_preference_raw?: string;
  appointment_schedule_iso?: string;
  appointment_schedule_iso_end?: string;
  schedule_confirmed?: boolean;
  schedule_pending_clarification?: boolean;
  schedule_clarification_prompt?: string;
  intake_intro_delivered?: boolean;
  caller_name_declined?: boolean;
  caller_name_unavailable?: boolean;
  caller_first_name?: string;
  caller_last_name?: string;
  name_awaiting_last_name?: boolean;
  name_awaiting_last_name_spelling?: boolean;
  name_awaiting_first_name_spelling?: boolean;
  name_spelling_verified?: boolean;
  opening_name_complete?: boolean;
  schedule_daypart?: "morning" | "afternoon" | "evening";
  name_clarification_attempts?: number;
  additional_notes_responded?: boolean;
  name_needs_clarification?: boolean;
  call_reason_awaiting_clarification?: boolean;
  call_reason_clarification_attempts?: number;
  pending_question?: string;
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

export function buildStructuredSpokenSummary(fields: RealtimeFields): string {
  const { summary, issues } = buildValidatedSpokenSummary(fields);

  if (issues.includes("invalid_name")) {
    return "";
  }

  if (!summary) {
    return "Let me make sure I have everything right.";
  }

  return summary.replace(/^Here's what I have\./, "Let me make sure I have everything right.");
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

  if (!normalized) {
    return false;
  }

  if (normalized.split(/\s+/).length > 5) {
    return false;
  }

  if (/\b(calling|call about|roof|hail|damage|leak|insurance|appointment|address|phone|name)\b/i.test(normalized)) {
    return false;
  }

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
