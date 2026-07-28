import { isPlausibleServiceAddress } from "./field-validation.js";

const STRONG_ADDRESS_BOUNDARY_PATTERNS: RegExp[] = [
  /\s+\banother\s+storm\b/i,
  /\s+\ba\s+storm\b/i,
  /\s+\bthe\s+storm\b/i,
  /\s+\bbecause\b/i,
  /\s+\bsince\b/i,
  /\s+\bso\s+i\b/i,
  /,\s*and\s+i\b/i,
  /\s+\band\s+i['']?m\b/i,
  /\s+\band\s+i\s+need\b/i,
  /\s+\band\s+i\s+live\b/i,
  /\s+\band\s+we\s+need\b/i,
  /\s+\bi['']?d\s+like\b/i,
  /\s+\bi\s+would\s+like\b/i,
  /\s+\bi\s+need\s+someone\b/i,
  /\s+\bsomeone\s+should\b/i,
  /\s+\bit\s+is\s+urgent\b/i,
  /\s+\bit['']?s\s+urgent\b/i,
  /\s+\bas\s+soon\s+as\s+possible\b/i,
  /\s+\btomorrow\b/i,
  /\s+\bwhen\s+it\s+rains\b/i,
  /\s+\binsurance\b/i,
  /\s+\badjuster\b/i,
  /\s+\bcall\s+me\b/i,
  /\s+\breach\s+me\b/i,
  /\s+\bavailable\b/i,
  /\s+\bafter\s+work\b/i,
];

const NON_ADDRESS_CLAUSE_PATTERNS: RegExp[] = [
  /\bstorm\s+is\s+supposed\b/i,
  /\bneed\s+someone\s+out\b/i,
  /\bas\s+soon\s+as\s+possible\b/i,
  /\bhaven['']?t\s+contacted\s+insurance\b/i,
  /\bcall\s+me\s+after\b/i,
  /\bavailable\s+after\s+work\b/i,
  /\banother\s+storm\b/i,
];

const WEAK_ADDRESS_BOUNDARY_PATTERN =
  /\s+\b(because|since|but|also|however|which|that|then|if|when)\b/i;

export function trimAddressAtConversationalBoundary(address: string): string {
  let trimmed = address.trim();

  if (!trimmed) {
    return trimmed;
  }

  const sentenceBoundary = trimmed.match(/^(.+?[.!?])(?:\s+|$)/);
  if (sentenceBoundary?.[1]) {
    const firstSentence = sentenceBoundary[1].replace(/[.!?]+$/, "").trim();
    if (firstSentence.length >= 8 && /\d/.test(firstSentence)) {
      trimmed = firstSentence;
    }
  }

  for (const pattern of STRONG_ADDRESS_BOUNDARY_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.index !== undefined && match.index >= 8) {
      trimmed = trimmed.slice(0, match.index).trim().replace(/[,.]$/, "");
      break;
    }
  }

  const weakMatch = trimmed.match(WEAK_ADDRESS_BOUNDARY_PATTERN);
  if (weakMatch?.index !== undefined && weakMatch.index >= 8) {
    trimmed = trimmed.slice(0, weakMatch.index).trim().replace(/[,.]$/, "");
  }

  return trimmed;
}

export function containsNonAddressContinuation(address: string): boolean {
  return NON_ADDRESS_CLAUSE_PATTERNS.some((pattern) => pattern.test(address));
}

export function normalizeAddressPunctuation(address: string): string {
  let formatted = address.trim().replace(/\s+/g, " ");

  formatted = formatted.replace(/\s+in\s+/gi, ", ");
  formatted = formatted.replace(/,\s*,/g, ", ");

  return formatted.replace(/[,.]$/, "").trim();
}

export function sanitizeServiceAddress(address: string): string | null {
  const trimmed = trimAddressAtConversationalBoundary(address)
    .replace(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g, " ")
    .replace(/\b(call me at|my number is|phone number is|callback number is)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!trimmed) {
    return null;
  }

  const normalized = normalizeAddressPunctuation(trimmed);

  if (containsNonAddressContinuation(normalized)) {
    return null;
  }

  if (!isPlausibleServiceAddress(normalized)) {
    return null;
  }

  return normalized;
}
