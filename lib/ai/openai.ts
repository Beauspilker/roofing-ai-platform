import OpenAI from "openai";

let client: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  client ??= new OpenAI({ apiKey });
  return client;
}

export async function generateTextResponse(
  input: string,
  instructions?: string,
): Promise<string | null> {
  const openai = getOpenAIClient();

  if (!openai) {
    return null;
  }

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input,
    ...(instructions ? { instructions } : {}),
  });

  const text = response.output_text?.trim();
  return text || null;
}
