import { generateTextResponse } from "@/lib/ai/openai";
import { OPENING_GREETING } from "@/lib/twilio/helpers";

const RECEPTIONIST_INSTRUCTIONS =
  "You are a friendly roofing company phone receptionist. Reply with one short spoken greeting sentence only. No quotes, labels, or extra commentary.";

const RECEPTIONIST_PROMPT =
  "Generate a short phone greeting for Beau's Roofing. It should sound like: Hi, this is Beau's Roofing. What can I help you with today?";

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

  return OPENING_GREETING;
}

const FALLBACK_CONVERSATION =
  "I'm having trouble right now. What can I help you with today?";

const FALLBACK_CONVERSATION_INSTRUCTIONS =
  "You are a friendly roofing receptionist for Beau's Roofing on a live phone call. " +
  "Reply in one or two short spoken sentences. Ask only one question at a time. " +
  "Do not use repetitive sympathy phrases. No quotes, labels, or bullet points.";

export async function generateConversationResponse(
  userMessage: string,
): Promise<string> {
  try {
    const response = await generateTextResponse(
      userMessage,
      FALLBACK_CONVERSATION_INSTRUCTIONS,
    );

    if (response) {
      return response;
    }
  } catch {
    // Fall back when OpenAI is unavailable.
  }

  return FALLBACK_CONVERSATION;
}
