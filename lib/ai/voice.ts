import { generateTextResponse } from "@/lib/ai/openai";
import { OPENING_GREETING } from "@/lib/twilio/helpers";

const RECEPTIONIST_INSTRUCTIONS =
  "You are a calm roofing office receptionist. Reply with one short spoken sentence. Use contractions. No quotes or labels.";

const RECEPTIONIST_PROMPT =
  "Generate a short phone greeting for Beau's Roofing. Sound like a calm office coordinator. Under twenty words.";

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
  "I'm having a little trouble on my end. What's going on with the roof?";

const FALLBACK_CONVERSATION_INSTRUCTIONS =
  "You are a calm roofing office receptionist for Beau's Roofing on a live phone call. " +
  "Reply in one or two short spoken sentences. Use contractions. Ask only one question. " +
  "No quotes, labels, or bullet points.";

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
