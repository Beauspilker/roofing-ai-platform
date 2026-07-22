const DAMAGE_AND_INTAKE_TERMS =
  /\b(hail(?:\s+damage)?|storm(?:\s+damage)?|roof(?:ing)?(?:\s+leak)?|roof\s+leak|leak(?:ing)?|missing\s+shingles?|shingles?|damage|damaged|insurance|claim|adjuster|estimate|inspection|replacement|pictures?|photos?|appointment|today|tomorrow|morning|afternoon|evening|urgent|emergency|water|tree(?:\s+damage)?|wind|gutter|repair|replace|callback|address|property|number|yes|no|yeah|nope|yep|nah|correct|right)\b/i;

const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;

const DATE_OR_TIME_PATTERN =
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}\/\d{1,2})\b/i;

const NON_NAME_I_AM_LEAD_INS =
  /^(?:i'?m|i am)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;

const CALL_REASON_LEAD_IN_PATTERN =
  /\b(?:i'?m|i am|we'?re|we are)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;

const POSITIVE_NAME_INTRO_PATTERNS: RegExp[] = [
  /\b(?:my name is|name is)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,3})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\bthis is\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\b(?:it'?s|it is)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s*,\s*and\b)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)(?=\s*,)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+)\s+and\b/i,
  /\b(?:call me)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
];

const INVALID_CALLER_NAME_EXACT =
  /^(?:calling|call|calling about|calling for|having|needing|looking|wondering|trying|reporting|asking|roof|roofing|damage|hail|storm|leak|shingles|insurance|claim|pictures|photos|appointment|today|tomorrow|yes|no|yeah|nope|yep|nah|correct|right|and|with|from|who|about|for|the|this|that|it|its|i|i'm|im|am|are|we|our|my|your|have|has|had|uh|um|hmm)$/i;

const INVALID_CALLER_NAME_VERB =
  /^(?:am|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|must|need|want|got|get|getting|going|looking|wondering|trying|reporting|asking|calling|having|needing)$/i;

export function containsRoofingDamageLanguage(text: string): boolean {
  return DAMAGE_AND_INTAKE_TERMS.test(text.trim());
}

export function isNonNameIamLeadIn(speech: string): boolean {
  return NON_NAME_I_AM_LEAD_INS.test(speech.trim());
}

export function isCallReasonLeadInSpeech(speech: string): boolean {
  return CALL_REASON_LEAD_IN_PATTERN.test(speech.trim());
}

export function hasPositiveNameEvidence(speech: string): boolean {
  const trimmed = speech.trim();

  if (!trimmed || isNonNameIamLeadIn(trimmed) || isCallReasonLeadInSpeech(trimmed)) {
    return false;
  }

  return POSITIVE_NAME_INTRO_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isLikelyCallReasonSpeech(speech: string): boolean {
  const trimmed = speech.trim();

  if (!trimmed) {
    return false;
  }

  if (isCallReasonLeadInSpeech(trimmed)) {
    return true;
  }

  if (isPlausibleDamageDescription(trimmed)) {
    return true;
  }

  if (containsRoofingDamageLanguage(trimmed) && !hasPositiveNameEvidence(trimmed)) {
    return true;
  }

  return false;
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

  return (
    fields.pending_question?.trim() === "reason_for_call" ||
    fields.pending_question?.trim() === "call_reason"
  );
}

function tokenizeNameWords(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

export function isInvalidCallerNameWord(word: string): boolean {
  const normalized = word.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (INVALID_CALLER_NAME_EXACT.test(normalized)) {
    return true;
  }

  if (INVALID_CALLER_NAME_VERB.test(normalized)) {
    return true;
  }

  if (containsRoofingDamageLanguage(normalized)) {
    return true;
  }

  if (DATE_OR_TIME_PATTERN.test(normalized)) {
    return true;
  }

  return false;
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

  const words = tokenizeNameWords(trimmed);

  if (words.length === 0 || words.length > 4) {
    return false;
  }

  if (words.some((word) => isInvalidCallerNameWord(word))) {
    return false;
  }

  if (INVALID_CALLER_NAME_EXACT.test(trimmed.replace(/\s+/g, " "))) {
    return false;
  }

  if (containsRoofingDamageLanguage(trimmed)) {
    return false;
  }

  if (DATE_OR_TIME_PATTERN.test(trimmed)) {
    return false;
  }

  if (isCallReasonLeadInSpeech(trimmed) || isNonNameIamLeadIn(trimmed)) {
    return false;
  }

  if (
    /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  return /^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,3}$/.test(trimmed);
}

function refineNameCandidate(candidate: string): string | null {
  const words = candidate.trim().split(/\s+/).filter(Boolean);

  for (let length = words.length; length >= 1; length -= 1) {
    const prefix = words.slice(0, length).join(" ");

    if (isPlausibleCallerName(prefix)) {
      return prefix;
    }
  }

  return null;
}

export function extractExplicitCallerName(speech: string): string | null {
  const trimmed = speech.trim();

  if (!trimmed || isNonNameIamLeadIn(trimmed)) {
    return null;
  }

  for (const pattern of POSITIVE_NAME_INTRO_PATTERNS) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();

    if (!candidate) {
      continue;
    }

    const refined = refineNameCandidate(candidate);

    if (refined) {
      return refined;
    }
  }

  return null;
}

export function validateCallerNameCandidate(
  speech: string,
  options: { isDirectNameAnswer?: boolean; allowDirectNameWithoutIntro?: boolean } = {},
): { value: string | null; needsClarification: boolean } {
  const trimmed = speech.trim();

  if (!trimmed) {
    return { value: null, needsClarification: false };
  }

  const explicit = extractExplicitCallerName(trimmed);

  if (explicit) {
    return { value: explicit, needsClarification: false };
  }

  if (options.isDirectNameAnswer || options.allowDirectNameWithoutIntro) {
    const directCandidate = trimmed
      .replace(/^(?:it'?s|it is)\s+/i, "")
      .replace(/[.!?]+$/g, "")
      .trim();

    if (
      isLikelyCallReasonSpeech(directCandidate) ||
      isCallReasonLeadInSpeech(directCandidate) ||
      !isPlausibleCallerName(directCandidate)
    ) {
      return {
        value: null,
        needsClarification: options.isDirectNameAnswer && directCandidate.length > 0,
      };
    }

    return { value: directCandidate, needsClarification: false };
  }

  if (!hasPositiveNameEvidence(trimmed)) {
    return { value: null, needsClarification: false };
  }

  if (isLikelyCallReasonSpeech(trimmed) || !isPlausibleCallerName(trimmed)) {
    return { value: null, needsClarification: false };
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
  let updated: T = { ...fields };
  const storedName = updated.full_name?.trim();
  const pendingName = updated.name_pending_confirmation?.trim();

  if (storedName && !isPlausibleCallerName(storedName)) {
    updated = {
      ...updated,
      full_name: undefined,
      name_needs_clarification: false,
    };
  }

  if (pendingName && !isPlausibleCallerName(pendingName)) {
    updated = {
      ...updated,
      name_pending_confirmation: undefined,
      name_needs_clarification: false,
    };
  }

  return updated;
}

export function isPlausibleServiceAddress(address: string): boolean {
  const trimmed = address.trim();

  if (trimmed.length < 8 || trimmed.length > 200) {
    return false;
  }

  if (!/\d/.test(trimmed)) {
    return false;
  }

  if (
    containsRoofingDamageLanguage(trimmed) &&
    !/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i.test(
      trimmed,
    )
  ) {
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

  return (
    containsRoofingDamageLanguage(trimmed) ||
    /tree|water|hole|missing|broken|hit|fell|last night|yesterday/i.test(trimmed)
  );
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

  if (currentGuess && currentGuess.length <= 12 && isPlausibleCallerName(currentGuess)) {
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

export const EARLY_CALLER_NAME_QUESTION =
  "Could I start with your first and last name?";
