const DAMAGE_AND_INTAKE_TERMS =
  /\b(hail(?:\s+damage)?|storm(?:\s+damage)?|roof(?:ing)?(?:\s+leak)?|roof\s+leak|leak(?:ing)?|missing\s+shingles?|shingles?|damage|damaged|insurance|claim|adjuster|estimate|inspection|replacement|pictures?|photos?|appointment|today|tomorrow|morning|afternoon|evening|urgent|emergency|water|tree(?:\s+damage)?|wind|gutter|repair|replace|callback|address|property|number|yes|no|yeah|nope|yep|nah|correct|right)\b/i;

const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;

const DATE_OR_TIME_PATTERN =
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}\/\d{1,2})\b/i;

const EXPLICIT_NAME_INTRO_PATTERN =
  /\b(?:my name is|name is|this is|i am|i'm|i am|call me)\s+[A-Za-z]/i;

export function containsRoofingDamageLanguage(text: string): boolean {
  return DAMAGE_AND_INTAKE_TERMS.test(text.trim());
}

export function isLikelyCallReasonSpeech(speech: string): boolean {
  const trimmed = speech.trim();

  if (!trimmed) {
    return false;
  }

  if (isPlausibleDamageDescription(trimmed)) {
    return true;
  }

  return containsRoofingDamageLanguage(trimmed) && !EXPLICIT_NAME_INTRO_PATTERN.test(trimmed);
}

export function isOpeningReasonCaptureContext(
  fields: { problem_description?: string; pending_question?: string },
  options: { isFirstCallerTurn?: boolean } = {},
): boolean {
  if (options.isFirstCallerTurn === true) {
    return true;
  }

  if (!fields.problem_description?.trim()) {
    return true;
  }

  return fields.pending_question?.trim() === "call_reason";
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

  if (/^(calling|call|yes|no|yeah|nope|nah|correct|right)$/i.test(trimmed)) {
    return false;
  }

  if (containsRoofingDamageLanguage(trimmed)) {
    return false;
  }

  if (DATE_OR_TIME_PATTERN.test(trimmed)) {
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
    /\b(?:this is|i am|i'm|name's)\s+(?!calling\b|call(?:ing)?\s+(?:for|about|regarding)\b)([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
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
  options: { isDirectNameAnswer?: boolean; allowDirectNameWithoutIntro?: boolean } = {},
): { value: string | null; needsClarification: boolean } {
  const explicit = extractExplicitCallerName(speech);

  if (explicit) {
    return { value: explicit, needsClarification: false };
  }

  const trimmed = speech.trim();

  if (!trimmed) {
    return { value: null, needsClarification: false };
  }

  if (
    !options.isDirectNameAnswer &&
    !options.allowDirectNameWithoutIntro &&
    !EXPLICIT_NAME_INTRO_PATTERN.test(trimmed)
  ) {
    return { value: null, needsClarification: false };
  }

  if (isLikelyCallReasonSpeech(trimmed) || !isPlausibleCallerName(trimmed)) {
    if (options.isDirectNameAnswer && trimmed.length > 0) {
      return { value: null, needsClarification: true };
    }

    return { value: null, needsClarification: false };
  }

  if (options.isDirectNameAnswer || options.allowDirectNameWithoutIntro) {
    return { value: trimmed, needsClarification: false };
  }

  return { value: null, needsClarification: false };
}

export function sanitizeInvalidStoredCallerName<
  T extends {
    full_name?: string;
    problem_description?: string;
    name_pending_confirmation?: string;
    name_needs_clarification?: boolean;
  },
>(fields: T): T {
  const storedName = fields.full_name?.trim();

  if (!storedName || isPlausibleCallerName(storedName)) {
    return fields;
  }

  const existingReason = fields.problem_description?.trim();
  const restoredReason =
    existingReason || extractDamageOrCallReason(storedName) || storedName;

  return {
    ...fields,
    full_name: undefined,
    name_pending_confirmation: undefined,
    name_needs_clarification: false,
    problem_description: restoredReason,
  };
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

  return "I'm sorry, I didn't catch your name. Could you say it one more time?";
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
