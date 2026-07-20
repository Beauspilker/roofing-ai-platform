import type { CollectedFields } from "../../../../lib/call-intake.js";
import { buildSpokenCallSummary } from "../../../../lib/call-summary.js";

export const REALTIME_OPENING_GREETING =
  "Thanks for calling Beau's Roofing. How can I help you today?";

export const REALTIME_OPENING_QUESTION = "How can I help you today?";

export const REALTIME_ANYTHING_ELSE_QUESTION =
  "Is there anything else you'd like the roofing team to know?";

export type RealtimeFields = CollectedFields & {
  adjuster_contacted?: string;
  photos_available?: string;
};

/** Keep at most one intake question mark in a spoken assistant turn. */
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

export function buildRealtimeClosingMessage(fields: RealtimeFields): string {
  const summary = buildSpokenCallSummary(fields);
  const callbackPhone = fields.callback_phone?.trim();
  const followUp = callbackPhone
    ? `Someone from our team will follow up at ${callbackPhone}.`
    : "Someone from our team will follow up using the number you confirmed.";

  return (
    `${summary} I'll send this to the roofing team. ${followUp} ` +
    "Thanks for calling Beau's Roofing — have a great day."
  );
}

export function isAnythingElseDeclined(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /^(no|nope|nah|nothing|none|that's all|thats all|that is all|i'm good|im good|all set|nothing else)\b/.test(
      normalized,
    ) || normalized.includes("nothing else")
  );
}
