const DAMAGE_AND_INTAKE_TERMS =
  /\b(hail|storm|roof|roofing|leak|leaking|shingles?|damage|damaged|insurance|claim|adjuster|pictures?|photos?|tomorrow|morning|afternoon|evening|urgent|emergency|water|tree|wind|repair|replace|inspection|callback|address|property|number|yes|no|yeah|nope)\b/i;

const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;

export function containsRoofingDamageLanguage(text: string): boolean {
  return DAMAGE_AND_INTAKE_TERMS.test(text.trim());
}

export function isPlausibleCallerName(name: string): boolean {
  const trimmed = name.trim();

  if (trimmed.length < 2 || trimmed.length > 60) {
    return false;
  }

  if (/\d/.test(trimmed) || PHONE_PATTERN.test(trimmed)) {
    return false;
  }

  if (/[.!?]/.test(trimmed)) {
    return false;
  }

  if (trimmed.split(/\s+/).length > 4) {
    return false;
  }

  if (containsRoofingDamageLanguage(trimmed)) {
    return false;
  }

  if (/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)\b/i.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,3}$/.test(trimmed);
}

export function extractExplicitCallerName(speech: string): string | null {
  const patterns = [
    /\b(?:my name is|name is)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\b(?:this is|i am|i'm|name's)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = speech.match(pattern);
    const candidate = match?.[1]?.trim();

    if (candidate && isPlausibleCallerName(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function validateCallerNameCandidate(
  speech: string,
  options: { isDirectNameAnswer?: boolean } = {},
): { value: string | null; needsClarification: boolean } {
  const explicit = extractExplicitCallerName(speech);

  if (explicit) {
    return { value: explicit, needsClarification: false };
  }

  const trimmed = speech.trim();

  if (options.isDirectNameAnswer && isPlausibleCallerName(trimmed)) {
    return { value: trimmed, needsClarification: false };
  }

  if (options.isDirectNameAnswer && trimmed.length > 0) {
    return { value: null, needsClarification: true };
  }

  return { value: null, needsClarification: false };
}

export function isPlausibleServiceAddress(address: string): boolean {
  const trimmed = address.trim();

  if (trimmed.length < 8 || trimmed.length > 200) {
    return false;
  }

  if (!/\d/.test(trimmed)) {
    return false;
  }

  if (containsRoofingDamageLanguage(trimmed) && !/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i.test(trimmed)) {
    return false;
  }

  return true;
}

export function isPlausibleDamageDescription(text: string): boolean {
  const trimmed = text.trim();

  if (trimmed.length < 4) {
    return false;
  }

  if (isPlausibleCallerName(trimmed)) {
    return false;
  }

  return containsRoofingDamageLanguage(trimmed) || /tree|water|hole|missing|broken|hit|fell|last night|yesterday/i.test(trimmed);
}

export function extractDamageOrCallReason(speech: string): string | null {
  const trimmed = speech.trim();

  if (!isPlausibleDamageDescription(trimmed)) {
    return null;
  }

  return trimmed.slice(0, 500);
}

export function buildNameClarificationPrompt(
  currentGuess?: string,
  options: { askToSpell?: boolean } = {},
): string {
  if (options.askToSpell) {
    return "Could you spell your name for me?";
  }

  if (currentGuess && currentGuess.length <= 12) {
    return `I'm sorry, I heard "${currentGuess}," but I want to make sure I have your name right. Could you say or spell it one more time?`;
  }

  return "I'm sorry, I didn't catch your name clearly. Could you say it one more time?";
}

export function isCallerNameDeclinedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return (
    /\b(prefer not to|rather not|don't want to|do not want to|won't give|will not give|no name|not giving my name)\b/.test(
      normalized,
    ) || /\b(i'd rather not say|id rather not say)\b/.test(normalized)
  );
}

export function isCallerNameUnavailableSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /\b(don't know|do not know|not sure|can't remember|cant remember|unavailable)\b/.test(
    normalized,
  );
}

export const EARLY_CALLER_NAME_QUESTION = "Could I start with your name?";
