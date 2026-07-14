import {
  type SummaryFieldKey,
  isSummaryDataField,
} from "@/lib/call-summary";

export type FaqTopic = "insurance" | "service_area" | "inspection_cost" | "same_day";

export type IntakeFields = {
  problem_description?: string;
  full_name?: string;
  callback_phone?: string;
  address?: string;
  project_type?: string;
  active_leak?: string;
  storm_damage?: string;
  insurance_claim?: string;
  urgency?: string;
  appointment_preference?: string;
  additional_notes?: string;
  summary_delivered?: boolean;
  summary_confirmed?: boolean;
  summary_editing?: boolean;
  summary_edit_target?: string;
  emergency_acknowledged?: boolean;
};

export type IntakeStage =
  | "problem"
  | "full_name"
  | "callback_phone"
  | "address"
  | "project_type"
  | "active_leak"
  | "storm_damage"
  | "insurance_claim"
  | "urgency"
  | "appointment"
  | "additional_notes";

const STAGE_FIELD_KEYS: Record<IntakeStage, keyof IntakeFields> = {
  problem: "problem_description",
  full_name: "full_name",
  callback_phone: "callback_phone",
  address: "address",
  project_type: "project_type",
  active_leak: "active_leak",
  storm_damage: "storm_damage",
  insurance_claim: "insurance_claim",
  urgency: "urgency",
  appointment: "appointment_preference",
  additional_notes: "additional_notes",
};

const INTERRUPTION_PAUSE_PATTERN =
  /^(actually|wait|hold on|hang on|one second|one sec|sorry|let me check|give me a sec)\.?$/i;

const INTERRUPTION_PREFIX_PATTERN =
  /^(actually|wait|hold on|hang on|one second|one sec|sorry)[,.]?\s+/i;

const CORRECTION_PREFIX_PATTERN =
  /^(no|actually|wait|not|correction)[,.]?\s+/i;

const SMALL_TALK_PATTERN =
  /\b(how'?s your day|how are you|how'?s it going|hope you'?re|staying dry|been crazy|pretty crazy|rough day|busy day)\b/i;

const FAQ_PATTERNS: Array<{ topic: FaqTopic; pattern: RegExp }> = [
  {
    topic: "insurance",
    pattern:
      /\b(work with insurance|insurance company|accept insurance|file a claim|insurance claim work)\b/i,
  },
  {
    topic: "service_area",
    pattern:
      /\b(serve my area|service area|do you cover|come to my area|service my area|in my town)\b/i,
  },
  {
    topic: "inspection_cost",
    pattern:
      /\b(how much|what does it cost|free inspection|charge for|inspection cost|cost of an inspection)\b/i,
  },
  {
    topic: "same_day",
    pattern:
      /\b(come today|same day|someone today|out today|this afternoon|right now)\b/i,
  },
];

const EMERGENCY_PATTERN =
  /\b(tree through|through the roof|roof collapse|collapsed|caved in|water pouring|pouring in|ceiling leaking badly|electrical hazard|spark|storm happening now|active storm|emergency|urgent|asap)\b/i;

const ROTATING_ACKS = [
  "Thanks.",
  "Understood.",
  "I appreciate that.",
  "That helps.",
] as const;

const USED_ACK_SUBSTRINGS = ["got it", "perfect", "okay", "ok."];

export function isInterruptionPause(speech: string): boolean {
  return INTERRUPTION_PAUSE_PATTERN.test(speech.trim());
}

export function stripInterruptionPrefix(speech: string): string {
  return speech.replace(INTERRUPTION_PREFIX_PATTERN, "").trim();
}

export function hasCorrectionIntent(speech: string): boolean {
  const normalized = speech.trim().toLowerCase();
  return (
    CORRECTION_PREFIX_PATTERN.test(normalized) ||
    /\b(not|actually|instead|rather|meant|correction|wrong)\b/.test(normalized)
  );
}

export function detectSmallTalk(speech: string): boolean {
  return SMALL_TALK_PATTERN.test(speech) && speech.trim().split(/\s+/).length <= 14;
}

export function buildSmallTalkResponse(speech: string): string {
  if (/how'?s your day|how are you|how'?s it going/i.test(speech)) {
    return "Doing well, thank you.";
  }
  if (/staying dry|crazy|storm|weather/i.test(speech)) {
    return "It's been a busy day on our end.";
  }
  return "I appreciate you saying that.";
}

export function detectFaqTopic(speech: string): FaqTopic | null {
  for (const entry of FAQ_PATTERNS) {
    if (entry.pattern.test(speech)) {
      return entry.topic;
    }
  }
  return null;
}

export function isLikelyFaqOnly(speech: string): boolean {
  const topic = detectFaqTopic(speech);
  if (!topic) {
    return false;
  }

  return speech.trim().split(/\s+/).length <= 18;
}

export function buildFaqResponse(topic: FaqTopic): string {
  switch (topic) {
    case "insurance":
      return "Yes, we regularly work with insurance claims and can help guide you through the process.";
    case "service_area":
      return "We serve homeowners throughout our local service area, and our team can confirm coverage for your address.";
    case "inspection_cost":
      return "Inspection details depend on the situation, and our team can walk you through that when they follow up.";
    case "same_day":
      return "We'll do our best to get someone out quickly, especially for urgent situations.";
  }
}

export function detectEmergency(speech: string): boolean {
  return (
    EMERGENCY_PATTERN.test(speech.toLowerCase()) ||
    /water.*(inside|coming in|pouring)|ceiling.*leak/i.test(speech.toLowerCase())
  );
}

export function buildEmergencyResponse(): string {
  return (
    "I'm sorry that's happening. " +
    "I've marked this as urgent so our team can prioritize it."
  );
}

export function pickRotatingAcknowledgment(
  priorPhrases: string[],
  turnIndex: number,
): string | null {
  for (let offset = 0; offset < ROTATING_ACKS.length; offset += 1) {
    const candidate = ROTATING_ACKS[(turnIndex + offset) % ROTATING_ACKS.length];
    const lowerPrior = priorPhrases.join(" ").toLowerCase();

    if (lowerPrior.includes(candidate.toLowerCase())) {
      continue;
    }

    if (USED_ACK_SUBSTRINGS.some((blocked) => lowerPrior.includes(blocked))) {
      continue;
    }

    return candidate;
  }

  return null;
}

export function buildInterruptionResume(currentQuestion: string | null): string {
  if (currentQuestion?.trim()) {
    return `No problem. ${currentQuestion}`;
  }

  return "No problem. Go ahead whenever you're ready.";
}

export function buildStageTransition(
  _answeredStage: IntakeStage | null,
  _nextStage: IntakeStage,
  _priorPhrases: string[],
  _turnIndex: number,
): string | null {
  return null;
}

export function buildCombinedResponse(
  prefixParts: Array<string | null | undefined>,
  question: string,
): string {
  const prefix = prefixParts.filter(Boolean).join(" ").trim();
  return prefix ? `${prefix} ${question}` : question;
}

export function applyTargetedCorrection(
  fields: IntakeFields,
  speech: string,
  currentStage: IntakeStage | "wrap_up",
  callerPhone?: string,
): { fields: IntakeFields; updated: boolean; field?: keyof IntakeFields } {
  const cleaned = stripInterruptionPrefix(speech)
    .replace(CORRECTION_PREFIX_PATTERN, "")
    .trim();
  const text = cleaned || speech.trim();
  const lower = text.toLowerCase();
  const updated: IntakeFields = { ...fields };

  const nameMatch = text.match(
    /(?:name is|my name is|i'?m|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})/i,
  );
  if (nameMatch?.[1]) {
    updated.full_name = nameMatch[1].trim();
    return { fields: updated, updated: true, field: "full_name" };
  }

  const addressMatch =
    text.match(
      /\b(?:address is|at|to)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i,
    ) ??
    text.match(
      /(?:change|update|correct|fix).*?(?:address|location|property).*?(?:to|is)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i,
    );
  if (addressMatch?.[1]) {
    updated.address = addressMatch[1].trim();
    return { fields: updated, updated: true, field: "address" };
  }

  const phone = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/,
  );
  if (phone) {
    const digits = phone[0].replace(/\D/g, "").slice(-10);
    updated.callback_phone = digits;
    return { fields: updated, updated: true, field: "callback_phone" };
  }

  if (/wind damage|\bwind\b/i.test(lower)) {
    updated.project_type = "wind damage";
    updated.storm_damage = "yes";
    if (!updated.problem_description?.toLowerCase().includes("wind")) {
      updated.problem_description = text;
    }
    return { fields: updated, updated: true, field: "project_type" };
  }

  if (/hail/i.test(lower)) {
    updated.project_type = "storm damage";
    updated.storm_damage = "yes";
    return { fields: updated, updated: true, field: "project_type" };
  }

  if (
    /appointment|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d\s*(am|pm)/i.test(
      text,
    )
  ) {
    updated.appointment_preference = text;
    return { fields: updated, updated: true, field: "appointment_preference" };
  }

  if (/^(yes|yeah|yep|no|nope|nah)\b/i.test(lower) && fields.insurance_claim) {
    updated.insurance_claim = /^(yes|yeah|yep)\b/i.test(lower) ? "yes" : "no";
    return { fields: updated, updated: true, field: "insurance_claim" };
  }

  if (hasCorrectionIntent(speech) && text.length > 0) {
    if (currentStage === "wrap_up" || fields.summary_delivered) {
      return { fields, updated: false };
    }

    const fieldKey = STAGE_FIELD_KEYS[currentStage];
    (updated as Record<string, string>)[fieldKey] = text;
    return { fields: updated, updated: true, field: fieldKey };
  }

  if (callerPhone && /same number|this number/i.test(lower)) {
    updated.callback_phone = callerPhone;
    return { fields: updated, updated: true, field: "callback_phone" };
  }

  return { fields, updated: false };
}

export function detectSummaryEditTarget(speech: string): SummaryFieldKey | null {
  const lower = speech.toLowerCase();

  if (/\b(address|location|property|street)\b/.test(lower)) {
    return "address";
  }
  if (/\b(name)\b/.test(lower)) {
    return "full_name";
  }
  if (/\b(phone|number|callback)\b/.test(lower)) {
    return "callback_phone";
  }
  if (
    /\b(appointment|schedule|time|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      lower,
    )
  ) {
    return "appointment_preference";
  }
  if (/\b(insurance|claim)\b/.test(lower)) {
    return "insurance_claim";
  }
  if (/\b(leak|water)\b/.test(lower)) {
    return "active_leak";
  }
  if (/\b(damage|hail|wind|storm|roof)\b/.test(lower)) {
    return "problem_description";
  }
  if (/\b(urgent|urgency|asap|priority)\b/.test(lower)) {
    return "urgency";
  }
  if (/\b(note|notes|anything else)\b/.test(lower)) {
    return "additional_notes";
  }

  return null;
}

function extractYesNoValue(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  if (/^(yes|yeah|yep|yup|correct|sure|absolutely)\b/.test(normalized)) {
    return "yes";
  }

  if (/^(no|nope|nah|not|none|negative)\b/.test(normalized)) {
    return "no";
  }

  return null;
}

export function applySummaryFieldValue(
  fields: IntakeFields,
  speech: string,
  target: SummaryFieldKey,
  callerPhone?: string,
): { fields: IntakeFields; updated: boolean; field?: SummaryFieldKey } {
  const cleaned = stripInterruptionPrefix(speech)
    .replace(CORRECTION_PREFIX_PATTERN, "")
    .trim();
  const text = cleaned || speech.trim();
  const lower = text.toLowerCase();
  const updated: IntakeFields = { ...fields };

  switch (target) {
    case "full_name": {
      const nameMatch = text.match(
        /(?:name is|my name is|i'?m|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})/i,
      );
      if (nameMatch?.[1]) {
        updated.full_name = nameMatch[1].trim();
        return { fields: updated, updated: true, field: target };
      }
      if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2}$/.test(text)) {
        updated.full_name = text;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "address": {
      const addressMatch =
        text.match(
          /\b(?:address is|at|to)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i,
        ) ??
        text.match(/(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i);
      if (addressMatch?.[1]) {
        updated.address = addressMatch[1].trim();
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "callback_phone": {
      const phone = text.match(
        /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/,
      );
      if (phone) {
        updated.callback_phone = phone[0].replace(/\D/g, "").slice(-10);
        return { fields: updated, updated: true, field: target };
      }
      if (callerPhone && /same number|this number/i.test(lower)) {
        updated.callback_phone = callerPhone;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "appointment_preference":
      if (
        text.length > 0 &&
        /appointment|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d\s*(am|pm)/i.test(
          text,
        )
      ) {
        updated.appointment_preference = text;
        return { fields: updated, updated: true, field: target };
      }
      break;
    case "insurance_claim": {
      const yesNo = extractYesNoValue(text);
      if (yesNo) {
        updated.insurance_claim = yesNo;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "active_leak": {
      const yesNo = extractYesNoValue(text);
      if (yesNo) {
        updated.active_leak = yesNo;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "urgency":
      if (/emergency|urgent|asap|today|flexible|soon|week/i.test(lower)) {
        updated.urgency = lower.includes("flex") ? "flexible" : lower.match(/emergency|urgent|asap|today/) ? "emergency" : "standard";
        return { fields: updated, updated: true, field: target };
      }
      break;
    case "problem_description":
    case "project_type":
    case "storm_damage":
      if (text.length > 3) {
        if (/hail|storm/i.test(lower)) {
          updated.project_type = "storm damage";
          updated.storm_damage = "yes";
        } else if (/wind/i.test(lower)) {
          updated.project_type = "wind damage";
          updated.storm_damage = "yes";
        }
        updated.problem_description = text;
        return { fields: updated, updated: true, field: "problem_description" };
      }
      break;
    case "additional_notes":
      if (text.length > 0 && !/^(no|nope|nah|nothing|none)\b/i.test(lower)) {
        updated.additional_notes = text;
        return { fields: updated, updated: true, field: target };
      }
      break;
  }

  return { fields, updated: false };
}

export type SummaryEditOutcome =
  | {
      status: "updated";
      fields: IntakeFields;
      field: SummaryFieldKey;
    }
  | {
      status: "awaiting_value";
      fields: IntakeFields;
      target: SummaryFieldKey;
    }
  | {
      status: "unchanged";
    };

export function processSummaryEdit(
  fields: IntakeFields,
  speech: string,
  callerPhone?: string,
): SummaryEditOutcome {
  const pendingTarget =
    typeof fields.summary_edit_target === "string" &&
    isSummaryDataField(fields.summary_edit_target)
      ? fields.summary_edit_target
      : null;
  const awaitingValue = fields.summary_editing === true && pendingTarget !== null;

  if (awaitingValue && pendingTarget) {
    const applied = applySummaryFieldValue(
      fields,
      speech,
      pendingTarget,
      callerPhone,
    );

    if (applied.updated && applied.field) {
      return {
        status: "updated",
        fields: applied.fields,
        field: applied.field,
      };
    }

    return {
      status: "awaiting_value",
      fields,
      target: pendingTarget,
    };
  }

  const correction = applyTargetedCorrection(
    fields,
    speech,
    "wrap_up",
    callerPhone,
  );

  if (
    correction.updated &&
    correction.field &&
    isSummaryDataField(correction.field) &&
    correction.field !== "additional_notes"
  ) {
    return {
      status: "updated",
      fields: correction.fields,
      field: correction.field,
    };
  }

  if (
    correction.updated &&
    correction.field === "additional_notes" &&
    /\b(note|mention|add|also)\b/i.test(speech)
  ) {
    return {
      status: "updated",
      fields: correction.fields,
      field: "additional_notes",
    };
  }

  const target = detectSummaryEditTarget(speech);

  if (target) {
    const applied = applySummaryFieldValue(fields, speech, target, callerPhone);

    if (applied.updated && applied.field) {
      return {
        status: "updated",
        fields: applied.fields,
        field: applied.field,
      };
    }

    return {
      status: "awaiting_value",
      fields: {
        ...fields,
        summary_editing: true,
        summary_edit_target: target,
      },
      target,
    };
  }

  return { status: "unchanged" };
}

export function buildSummaryEditAcknowledgment(): string {
  return "Understood, I've updated that. Is everything else correct?";
}

export function isSummaryFinalConfirmation(speech: string): boolean {
  const normalized = speech.toLowerCase().trim();
  return /^(that'?s all|thats all|nothing else|no that'?s it|we'?re good|all set|nope that'?s it)\b/.test(
    normalized,
  );
}
