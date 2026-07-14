import { generateTextResponse } from "@/lib/ai/openai";
import type { ConversationMemoryContext } from "@/lib/call-sessions";
import { formatCollectedFields } from "@/lib/call-sessions";

const FALLBACK_GREETING =
  "Thank you for calling. This is the Roofing AI assistant. How can I help you today?";

const RECEPTIONIST_INSTRUCTIONS =
  "You are a friendly roofing company phone receptionist. Reply with one short spoken greeting sentence only. No quotes, labels, or extra commentary.";

const RECEPTIONIST_PROMPT =
  "Generate a short phone greeting for Beau's Roofing. It should sound like: Thank you for calling. This is Beau's Roofing AI assistant. How can I help you today?";

export async function generateVoiceResponse(): Promise<string> {
  try {
    const greeting = await generateTextResponse(
      RECEPTIONIST_PROMPT,
      RECEPTIONIST_INSTRUCTIONS,
    );

    if (greeting) {
      return greeting;
    }
  } catch {
    // Fall back to the static greeting when OpenAI is unavailable.
  }

  return FALLBACK_GREETING;
}

const FALLBACK_CONVERSATION =
  "I'm sorry, I'm having trouble right now. Could you tell me a bit more about your roof?";

const CONVERSATION_INSTRUCTIONS =
  "You are a friendly roofing receptionist for Beau's Roofing on a live phone call. " +
  "Reply in one or two short spoken sentences. Ask only one question at a time. " +
  "Use a brief, varied acknowledgement before your question — examples: Got it. Thanks for explaining. I understand. Okay. Thanks. Perfect. That helps. Alright. " +
  "Never say I'm sorry to hear that or similar repetitive sympathy phrases. " +
  "Never ask for information already listed under collected information. " +
  "Continue from the current conversation stage. " +
  "Help with roof leaks, damage, repairs, and inspections. No quotes, labels, or bullet points.";

function buildConversationPrompt(
  userMessage: string,
  memory?: ConversationMemoryContext,
): string {
  if (!memory) {
    return userMessage;
  }

  const collectedSummary = formatCollectedFields(memory.collectedFields);
  const recentTurns = memory.transcript
    .slice(-6)
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n");

  return [
    `Caller just said: "${userMessage}"`,
    "",
    "Information already collected during this call (never ask for these again):",
    collectedSummary || "(none yet)",
    "",
    `Current conversation stage: ${memory.currentStage}`,
    `If you need to ask a question, ask only for: ${memory.stageLabel}.`,
    memory.currentStage === "wrap_up"
      ? "All intake questions are answered. Offer a brief helpful closing and ask if they need anything else."
      : "Include a brief varied acknowledgement, then ask the next needed question.",
    recentTurns ? `\nRecent conversation:\n${recentTurns}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateConversationResponse(
  userMessage: string,
  memory?: ConversationMemoryContext,
): Promise<string> {
  try {
    const response = await generateTextResponse(
      buildConversationPrompt(userMessage, memory),
      CONVERSATION_INSTRUCTIONS,
    );

    if (response) {
      return response;
    }
  } catch {
    // Fall back when OpenAI is unavailable.
  }

  return FALLBACK_CONVERSATION;
}
