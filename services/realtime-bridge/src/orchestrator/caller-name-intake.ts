import {
  extractExplicitCallerName,
  isLikelyCallReasonSpeech,
  isPlausibleCallerName,
  validateCallerNameCandidate,
} from "./field-validation.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export const OPENING_CALLER_NAME_QUESTION =
  "Could I start with your first and last name?";

export const CALL_REASON_AFTER_NAME_QUESTION =
  "What can the roofing team help you with today?";

const COMMON_SURNAMES = new Set([
  "smith",
  "johnson",
  "williams",
  "brown",
  "jones",
  "garcia",
  "miller",
  "davis",
  "wilson",
  "anderson",
  "taylor",
  "moore",
  "martin",
  "thompson",
  "white",
  "harris",
  "clark",
  "lewis",
  "walker",
  "hall",
  "young",
  "allen",
  "king",
  "wright",
  "scott",
  "green",
  "baker",
  "adams",
  "nelson",
  "hill",
]);

const REJECTION_PREFIX =
  /^(?:no|nope|nah|not quite|incorrect|wrong|that's wrong|thats wrong|that is wrong|not right|no[, ]+actually|actually|i meant|not[, ]+it'?s|not[, ]+it is)\b[, ]*/i;

function normalizeNamePart(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) =>
      part
        .split("-")
        .map((segment) => {
          if (!segment) {
            return segment;
          }
          return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
        })
        .join("-"),
    )
    .join(" ");
}

function stripRejectionPrefix(speech: string): string {
  let remaining = speech.trim();
  while (remaining) {
    const next = remaining.replace(REJECTION_PREFIX, "").trim();
    if (next === remaining) {
      break;
    }
    remaining = next;
  }
  return remaining.replace(/^[, ]+/, "").trim();
}

function parseLetterSequence(token: string): string | null {
  const letters = token.match(/\b([A-Za-z])\b/g);
  if (!letters || letters.length < 2) {
    return null;
  }
  return normalizeNamePart(letters.join(""));
}

export function parseSpelledNameSpeech(speech: string): {
  firstName: string | null;
  lastName: string | null;
} {
  const stripped = stripRejectionPrefix(speech);
  const segments = stripped
    .split(/\s*,\s*|\s+and\s+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const parsedSegments = segments
    .map((segment) => {
      if (/^[A-Za-z](?:[-.\s]+[A-Za-z])+$/i.test(segment)) {
        const letters = segment.replace(/[-.\s]+/g, "");
        return letters.length >= 2 ? normalizeNamePart(letters) : null;
      }
      return parseLetterSequence(segment.replace(/[-.\s]+/g, " "));
    })
    .filter((value): value is string => Boolean(value));

  if (parsedSegments.length >= 2) {
    return {
      firstName: parsedSegments[0] ?? null,
      lastName: parsedSegments.slice(1).join(" ") || null,
    };
  }

  if (parsedSegments.length === 1) {
    return { firstName: null, lastName: parsedSegments[0] ?? null };
  }

  return { firstName: null, lastName: null };
}

export function isSpelledNameSpeech(speech: string): boolean {
  const trimmed = speech.trim();

  if (/\b[A-Za-z](?:-[A-Za-z]){2,}\b/.test(trimmed)) {
    return true;
  }

  if (/\b[A-Za-z]\b(?:\s+\b[A-Za-z]\b){2,}/.test(trimmed)) {
    return true;
  }

  return false;
}

export function parseCallerNameParts(speech: string): {
  firstName: string | null;
  lastName: string | null;
} {
  const stripped = stripRejectionPrefix(speech);

  if (isSpelledNameSpeech(stripped)) {
    return parseSpelledNameSpeech(stripped);
  }

  const explicit = extractExplicitCallerName(stripped);
  if (explicit) {
    const words = explicit.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return {
        firstName: normalizeNamePart(words[0] ?? ""),
        lastName: normalizeNamePart(words.slice(1).join(" ")),
      };
    }
    return { firstName: normalizeNamePart(explicit), lastName: null };
  }

  const validated = validateCallerNameCandidate(stripped, {
    isDirectNameAnswer: true,
    allowDirectNameWithoutIntro: true,
  });

  if (validated.value) {
    const words = validated.value.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return {
        firstName: normalizeNamePart(words[0] ?? ""),
        lastName: normalizeNamePart(words.slice(1).join(" ")),
      };
    }
    return { firstName: normalizeNamePart(validated.value), lastName: null };
  }

  return { firstName: null, lastName: null };
}

export function isUncommonSurname(lastName: string): boolean {
  const normalized = lastName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (COMMON_SURNAMES.has(normalized)) {
    return false;
  }
  return normalized.length >= 7 || /[^a-z'-]/i.test(lastName) || /[qxz]/i.test(normalized);
}

export function syncFullNameFromParts(fields: RealtimeFields): RealtimeFields {
  const first = fields.caller_first_name?.trim();
  const last = fields.caller_last_name?.trim();

  if (first && last) {
    return {
      ...fields,
      full_name: `${first} ${last}`.slice(0, 100),
    };
  }

  if (first && !last) {
    return {
      ...fields,
      full_name: undefined,
    };
  }

  const full = fields.full_name?.trim();
  if (full) {
    const words = full.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return {
        ...fields,
        caller_first_name: normalizeNamePart(words[0] ?? ""),
        caller_last_name: normalizeNamePart(words.slice(1).join(" ")),
        full_name: normalizeNamePart(full).slice(0, 100),
      };
    }
    if (words.length === 1) {
      return {
        ...fields,
        caller_first_name: normalizeNamePart(words[0] ?? ""),
        full_name: undefined,
      };
    }
  }

  return fields;
}

export function hasCompleteCallerName(fields: RealtimeFields): boolean {
  const synced = syncFullNameFromParts(fields);
  const first = synced.caller_first_name?.trim();
  const last = synced.caller_last_name?.trim();
  return Boolean(
    first &&
      last &&
      isPlausibleCallerName(first) &&
      isPlausibleCallerName(last) &&
      isPlausibleCallerName(`${first} ${last}`),
  );
}

export function getCallerFirstName(fields: RealtimeFields): string | undefined {
  return syncFullNameFromParts(fields).caller_first_name?.trim();
}

export function buildLastNameFollowUp(firstName: string): string {
  return `Thanks, ${firstName}. Could I also get your last name?`;
}

export function buildLastNameSpellingPrompt(): string {
  return "Could you spell your last name for me so I make sure the roofing team has it correctly?";
}

export function buildFirstNameSpellingPrompt(): string {
  return "Could you spell your first name as well?";
}

export function buildNameCompleteAcknowledgment(fields: RealtimeFields): string {
  const synced = syncFullNameFromParts(fields);
  const full = synced.full_name?.trim() ?? "";
  if (full) {
    return `Thank you. I have ${full}.`;
  }
  return "Thank you.";
}

export function buildCallReasonQuestionAfterName(fields: RealtimeFields): string {
  const firstName = getCallerFirstName(fields);
  if (firstName) {
    return `Thank you, ${firstName}. ${CALL_REASON_AFTER_NAME_QUESTION}`;
  }
  return CALL_REASON_AFTER_NAME_QUESTION;
}

export type CallerNameTurnOutcome = {
  fields: RealtimeFields;
  replyText: string | null;
  complete: boolean;
  needsReasonQuestion: boolean;
};

export function processCallerNameTurn(
  fields: RealtimeFields,
  speech: string,
): CallerNameTurnOutcome {
  let updated: RealtimeFields = { ...fields };
  const trimmed = speech.trim();

  if (updated.name_awaiting_first_name_spelling) {
    const spelled = parseSpelledNameSpeech(trimmed);
    if (spelled.firstName && isPlausibleCallerName(spelled.firstName)) {
      updated = syncFullNameFromParts({
        ...updated,
        caller_first_name: spelled.firstName,
        name_awaiting_first_name_spelling: false,
        name_needs_clarification: false,
      });
      if (hasCompleteCallerName(updated)) {
        return {
          fields: updated,
          replyText: null,
          complete: true,
          needsReasonQuestion: true,
        };
      }
    }
    return {
      fields: updated,
      replyText: buildFirstNameSpellingPrompt(),
      complete: false,
      needsReasonQuestion: false,
    };
  }

  if (updated.name_awaiting_last_name_spelling) {
    const spelled = parseSpelledNameSpeech(trimmed);
    const lastName = spelled.lastName ?? spelled.firstName;
    if (lastName && isPlausibleCallerName(lastName)) {
      updated = syncFullNameFromParts({
        ...updated,
        caller_last_name: lastName,
        name_awaiting_last_name_spelling: false,
        name_needs_clarification: false,
        name_spelling_verified: true,
      });
      if (hasCompleteCallerName(updated)) {
        const ack =
          updated.name_spelling_verified === true
            ? buildNameCompleteAcknowledgment(updated)
            : null;
        return {
          fields: updated,
          replyText: ack,
          complete: true,
          needsReasonQuestion: true,
        };
      }
    }
    return {
      fields: updated,
      replyText: buildLastNameSpellingPrompt(),
      complete: false,
      needsReasonQuestion: false,
    };
  }

  if (updated.name_awaiting_last_name) {
    const parts = parseCallerNameParts(trimmed);
    const lastName = parts.lastName ?? (parts.firstName && !parts.lastName ? parts.firstName : null);
    if (lastName && isPlausibleCallerName(lastName)) {
      updated = syncFullNameFromParts({
        ...updated,
        caller_last_name: lastName,
        name_awaiting_last_name: false,
      });
    if (updated.name_needs_clarification === true) {
      updated.name_awaiting_last_name_spelling = true;
      updated.name_spelling_verified = false;
      return {
        fields: updated,
        replyText: buildLastNameSpellingPrompt(),
        complete: false,
        needsReasonQuestion: false,
      };
    }
      return {
        fields: updated,
        replyText: null,
        complete: true,
        needsReasonQuestion: true,
      };
    }
    return {
      fields: updated,
      replyText: buildLastNameFollowUp(updated.caller_first_name ?? "there"),
      complete: false,
      needsReasonQuestion: false,
    };
  }

  const parts = parseCallerNameParts(trimmed);

  if (parts.firstName && parts.lastName) {
    const needsSpelling = fields.name_needs_clarification === true;
    updated = syncFullNameFromParts({
      ...updated,
      caller_first_name: parts.firstName,
      caller_last_name: parts.lastName,
      name_awaiting_last_name: false,
      name_needs_clarification: false,
    });

    if (needsSpelling) {
      updated.name_awaiting_last_name_spelling = true;
      updated.name_spelling_verified = false;
      return {
        fields: updated,
        replyText: buildLastNameSpellingPrompt(),
        complete: false,
        needsReasonQuestion: false,
      };
    }

    return {
      fields: updated,
      replyText: null,
      complete: true,
      needsReasonQuestion: true,
    };
  }

  if (parts.firstName) {
    updated = syncFullNameFromParts({
      ...updated,
      caller_first_name: parts.firstName,
      name_awaiting_last_name: true,
      name_needs_clarification: false,
    });
    return {
      fields: updated,
      replyText: buildLastNameFollowUp(parts.firstName),
      complete: false,
      needsReasonQuestion: false,
    };
  }

  if (isLikelyCallReasonSpeech(trimmed) && !extractExplicitCallerName(trimmed)) {
    return {
      fields: updated,
      replyText: OPENING_CALLER_NAME_QUESTION,
      complete: false,
      needsReasonQuestion: false,
    };
  }

  updated = {
    ...updated,
    name_needs_clarification: true,
    name_clarification_attempts: (updated.name_clarification_attempts ?? 0) + 1,
  };

  return {
    fields: updated,
    replyText: OPENING_CALLER_NAME_QUESTION,
    complete: false,
    needsReasonQuestion: false,
  };
}
