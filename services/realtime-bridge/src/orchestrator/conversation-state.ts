export type ConversationState =
  | "collecting_intake"
  | "presenting_summary"
  | "awaiting_summary_confirmation"
  | "handling_correction"
  | "awaiting_additional_notes"
  | "delivering_closing"
  | "closing_audio_playback"
  | "completed";

export const SUMMARY_CONFIRMATION_QUESTION = "Does all of that sound correct?";

export const SUMMARY_RECONFIRMATION_QUESTION = "Does that sound correct now?";

export const CLOSING_MESSAGE =
  "Perfect. I'll send this information to the roofing team, and someone will follow up with you by call or text. " +
  "Thanks for calling Beau's Roofing. Have a great day.";

export function isAwaitingCallerInput(state: ConversationState): boolean {
  return (
    state === "collecting_intake" ||
    state === "awaiting_additional_notes" ||
    state === "awaiting_summary_confirmation" ||
    state === "handling_correction"
  );
}

export function blocksAutomatedClosing(state: ConversationState): boolean {
  return (
    state === "presenting_summary" ||
    state === "awaiting_summary_confirmation" ||
    state === "handling_correction"
  );
}

export function blocksCallerTurnProcessing(state: ConversationState): boolean {
  return (
    state === "delivering_closing" ||
    state === "closing_audio_playback" ||
    state === "completed"
  );
}
