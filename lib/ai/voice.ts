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
