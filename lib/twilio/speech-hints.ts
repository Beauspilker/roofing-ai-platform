import { BASE_SPEECH_GATHER_HINTS } from "@/lib/twilio/voice-config";
import { createServiceClient } from "@/lib/supabase/service";

const NAME_HINT_WORDS = ["first name", "last name"];

function splitHintTokens(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

export function buildSpeechHints(input?: {
  ownerName?: string | null;
  companyName?: string | null;
}): string {
  const dynamicHints = new Set<string>(NAME_HINT_WORDS);

  if (input?.ownerName) {
    for (const token of splitHintTokens(input.ownerName)) {
      dynamicHints.add(token);
    }

    dynamicHints.add(input.ownerName.trim());
  }

  if (input?.companyName) {
    for (const token of splitHintTokens(input.companyName)) {
      dynamicHints.add(token);
    }
  }

  return `${BASE_SPEECH_GATHER_HINTS}, ${[...dynamicHints].join(", ")}`;
}

export async function getCompanySpeechHints(
  companyId: string,
): Promise<string> {
  const supabase = createServiceClient();

  if (!supabase || !companyId) {
    return buildSpeechHints();
  }

  const { data, error } = await supabase
    .from("companies")
    .select("owner_name, company_name")
    .eq("id", companyId)
    .maybeSingle();

  if (error || !data) {
    return buildSpeechHints();
  }

  return buildSpeechHints({
    ownerName: data.owner_name,
    companyName: data.company_name,
  });
}
