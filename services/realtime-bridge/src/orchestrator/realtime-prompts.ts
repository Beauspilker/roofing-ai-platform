import type { CollectedFields } from "../../../../lib/call-intake.js";
import { buildSpokenCallSummary } from "../../../../lib/call-summary.js";

export const REALTIME_OPENING_GREETING =
  "Hi, thanks for calling Beau's Roofing — what's going on with the roof?";

export const REALTIME_OPENING_QUESTION = "What's going on with the roof?";

export const REALTIME_ANYTHING_ELSE_QUESTION =
  "Is there anything else you'd like the roofing team to know?";

export type RealtimeFields = CollectedFields & {
  adjuster_contacted?: string;
  photos_available?: string;
};

export function buildRealtimeIntakeReply(
  prefix: string | null,
  question: string,
): string {
  const trimmedQuestion = question.trim();

  if (!prefix) {
    return trimmedQuestion;
  }

  return `${prefix} ${trimmedQuestion}`.replace(/\s+/g, " ").trim();
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
