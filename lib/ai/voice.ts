import { generateTextResponse } from "@/lib/ai/openai";

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
  "I'm having trouble right now. Please tell me what is going on with your roof today.";

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
