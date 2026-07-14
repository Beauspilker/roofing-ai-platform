import { OPENING_GREETING } from "@/lib/twilio/helpers";
import {
  applyTargetedCorrection,
  buildCombinedResponse,
  buildEmergencyResponse,
  detectEmergency,
  hasCorrectionIntent,
  stripInterruptionPrefix,
} from "@/lib/call-intelligence";
import {
  buildCrmCallSummary,
  buildSpokenCallSummary,
  getSummaryConfirmationPrompt,
} from "@/lib/call-summary";

export {
  buildCrmCallSummary,
  buildSpokenCallSummary,
  getSummaryConfirmationPrompt,
} from "@/lib/call-summary";

export { OPENING_GREETING };

export const CALL_INTAKE_STAGES = [
  "problem",
  "full_name",
  "callback_phone",
  "address",
  "project_type",
  "active_leak",
  "storm_damage",
  "insurance_claim",
  "urgency",
  "appointment",
  "additional_notes",
] as const;

export type CollectionStage = (typeof CALL_INTAKE_STAGES)[number];

export type ConversationStage = CollectionStage | "wrap_up";

export type CollectedFields = {
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

type IntakeFieldKey = Exclude<
  keyof CollectedFields,
  "summary_delivered" | "summary_confirmed" | "summary_editing" | "summary_edit_target" | "emergency_acknowledged"
>;

const STAGE_FIELD_KEYS: Record<CollectionStage, IntakeFieldKey> = {
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

const ROUTINE_STAGES: CollectionStage[] = [
  "full_name",
  "callback_phone",
  "address",
  "appointment",
  "insurance_claim",
  "additional_notes",
];

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function fieldText(value: string | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}

function isYesValue(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /^(yes|yeah|yep|yup|true|correct|sure)$/i.test(value.trim());
}

function isNoValue(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /^(no|nope|nah|false|none|not|negative)$/i.test(value.trim());
}

function indicatesWaterIntrusion(text: string): boolean {
  return /water.*(inside|in the|coming|getting in|pouring)|flooding|active leak|leaking inside/i.test(
    text.toLowerCase(),
  );
}

function indicatesStructuralEmergency(text: string): boolean {
  return /tree|through the roof|collapsed|caved|structural|fallen on/i.test(
    text.toLowerCase(),
  );
}

function indicatesStormDamage(text: string): boolean {
  return /hail|storm|wind damage|tornado|hurricane/i.test(text.toLowerCase());
}

function extractActiveLeak(text: string): string | null {
  if (indicatesWaterIntrusion(text)) {
    return "yes";
  }

  const yesNo = extractYesNo(text);
  if (yesNo && /leak|water|drip/i.test(text.toLowerCase())) {
    return yesNo;
  }

  return null;
}

function extractStormDamage(text: string): string | null {
  if (indicatesStormDamage(text)) {
    return "yes";
  }

  const yesNo = extractYesNo(text);
  if (yesNo && indicatesStormDamage(text)) {
    return yesNo;
  }

  return null;
}

export function getNextMissingStage(fields: CollectedFields): ConversationStage {
  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    if (!hasValue(fields[fieldKey])) {
      return stage;
    }
  }

  return "wrap_up";
}

export function isIntakeComplete(fields: CollectedFields): boolean {
  return getNextMissingStage(fields) === "wrap_up";
}

export function isAwaitingSummaryConfirmation(fields: CollectedFields): boolean {
  return (
    isIntakeComplete(fields) &&
    fields.summary_delivered === true &&
    fields.summary_confirmed !== true
  );
}

export function isAwaitingSummaryEditValue(fields: CollectedFields): boolean {
  return (
    fields.summary_editing === true &&
    typeof fields.summary_edit_target === "string" &&
    fields.summary_edit_target.length > 0
  );
}

export function clearSummaryEditState(fields: CollectedFields): CollectedFields {
  return {
    ...fields,
    summary_editing: false,
    summary_edit_target: undefined,
  };
}

function extractYesNo(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  if (
    /^(yes|yeah|yep|yup|correct|sure|absolutely|affirmative|it is|i am|we are|we do|there is|there's)\b/.test(
      normalized,
    )
  ) {
    return "yes";
  }

  if (
    /^(no|nope|nah|not|none|don't|do not|negative|isn't|aren't|there isn't|there's no)\b/.test(
      normalized,
    )
  ) {
    return "no";
  }

  return null;
}

function extractPhone(text: string): string | null {
  const match = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/,
  );

  if (!match) {
    return null;
  }

  const digits = match[0].replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function extractName(text: string): string | null {
  const explicit = text.match(
    /(?:my name is|name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})/,
  );

  if (explicit?.[1]) {
    return explicit[1].trim();
  }

  const introduction = text.match(
    /(?:this is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})(?:\s+(?:and|with|from|at|calling)\b|$)/,
  );

  if (introduction?.[1]) {
    return introduction[1].trim();
  }

  return null;
}

function extractAddress(text: string): string | null {
  const streetMatch = text.match(
    /\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80}(?:\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|place|pl)\b)?/i,
  );

  if (streetMatch) {
    return streetMatch[0].trim();
  }

  const atMatch = text.match(
    /\bat\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,60})/i,
  );

  return atMatch?.[1]?.trim() ?? null;
}

function extractProjectType(text: string): string | null {
  const normalized = text.toLowerCase();

  if (normalized.includes("storm") || normalized.includes("hail")) {
    return "storm damage";
  }
  if (normalized.includes("wind")) {
    return "wind damage";
  }
  if (normalized.includes("replace")) {
    return "replacement";
  }
  if (normalized.includes("repair")) {
    return "repair";
  }
  if (normalized.includes("inspect")) {
    return "inspection";
  }

  return null;
}

function extractUrgency(text: string): string | null {
  const normalized = text.toLowerCase();

  if (/emergency|urgent|asap|right away|immediately|today/.test(normalized)) {
    return "emergency";
  }
  if (/flexible|no rush|whenever|next week|few weeks/.test(normalized)) {
    return "flexible";
  }
  if (/standard|few days|this week|soon/.test(normalized)) {
    return "standard";
  }

  return null;
}

function extractCallbackPhone(
  text: string,
  callerPhone?: string,
): string | null {
  const normalized = text.toLowerCase();

  if (
    callerPhone &&
    /same number|this number|calling from|number i'?m calling|one i'?m on/.test(
      normalized,
    )
  ) {
    return callerPhone;
  }

  return extractPhone(text);
}

function normalizeFieldValue(
  stage: CollectionStage,
  answer: string,
  callerPhone?: string,
): string {
  const trimmed = answer.trim();

  switch (stage) {
    case "active_leak":
    case "storm_damage":
    case "insurance_claim":
      return extractYesNo(trimmed) ?? trimmed;
    case "callback_phone":
      return extractCallbackPhone(trimmed, callerPhone) ?? trimmed;
    case "project_type":
      return extractProjectType(trimmed) ?? trimmed;
    case "urgency":
      return extractUrgency(trimmed) ?? trimmed;
    case "additional_notes":
      if (/^(no|nope|nah|nothing|none|that's all|thats all|all set)\b/i.test(trimmed)) {
        return "none";
      }
      return trimmed;
    default:
      return trimmed;
  }
}

export function extractFieldsFromSpeech(
  text: string,
  callerPhone?: string,
): Partial<CollectedFields> {
  const extracted: Partial<CollectedFields> = {};
  const name = extractName(text);
  const phone = extractCallbackPhone(text, callerPhone) ?? extractPhone(text);
  const address = extractAddress(text);
  const projectType = extractProjectType(text);
  const urgency = extractUrgency(text);

  if (name) {
    extracted.full_name = name;
  }
  if (phone) {
    extracted.callback_phone = phone;
  }
  if (address) {
    extracted.address = address;
  }
  if (projectType) {
    extracted.project_type = projectType;
  }
  if (urgency) {
    extracted.urgency = urgency;
  }

  const activeLeak = extractActiveLeak(text);
  if (activeLeak) {
    extracted.active_leak = activeLeak;
  }

  const stormDamage = extractStormDamage(text);
  if (stormDamage) {
    extracted.storm_damage = stormDamage;
  }

  if (indicatesWaterIntrusion(text) || /emergency|urgent|asap/i.test(text.toLowerCase())) {
    extracted.urgency = extracted.urgency ?? "emergency";
  }

  return extracted;
}

export function mergeCallerAnswer(
  fields: CollectedFields,
  answer: string,
  callerPhone?: string,
): CollectedFields {
  const currentStage = getNextMissingStage(fields);

  if (hasCorrectionIntent(answer)) {
    const correction = applyTargetedCorrection(
      fields,
      answer,
      currentStage === "wrap_up" ? "wrap_up" : currentStage,
      callerPhone,
    );

    if (correction.updated) {
      const corrected = correction.fields as CollectedFields;
      if (detectEmergency(answer)) {
        corrected.urgency = corrected.urgency ?? "emergency";
        if (/water|leak|pouring/i.test(answer.toLowerCase())) {
          corrected.active_leak = "yes";
        }
      }
      return corrected;
    }
  }

  const processedAnswer = stripInterruptionPrefix(answer);
  const answeringStage = getNextMissingStage(fields);
  const updated: CollectedFields = { ...fields };
  const extracted = extractFieldsFromSpeech(processedAnswer, callerPhone);

  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    const extractedValue = extracted[fieldKey];

    if (!hasValue(updated[fieldKey]) && hasValue(extractedValue)) {
      updated[fieldKey] = extractedValue;
    }
  }

  if (detectEmergency(processedAnswer)) {
    updated.urgency = updated.urgency ?? "emergency";
  }

  if (answeringStage !== "wrap_up") {
    const primaryKey = STAGE_FIELD_KEYS[answeringStage];

    if (!hasValue(updated[primaryKey])) {
      updated[primaryKey] = normalizeFieldValue(
        answeringStage,
        processedAnswer,
        callerPhone,
      );
    }
  }

  return updated;
}

function countNewlyFilledFields(
  before: CollectedFields,
  after: CollectedFields,
): number {
  let count = 0;

  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    if (!hasValue(before[fieldKey]) && hasValue(after[fieldKey])) {
      count += 1;
    }
  }

  return count;
}

function wasPhraseUsedRecently(phrase: string, priorPhrases: string[]): boolean {
  const normalized = phrase.toLowerCase();

  return priorPhrases.some((entry) => entry.toLowerCase().includes(normalized));
}

function pickContextualEmpathy(
  answeredStage: CollectionStage,
  answerText: string,
  priorPhrases: string[],
): string | null {
  const text = answerText.toLowerCase();

  if (ROUTINE_STAGES.includes(answeredStage)) {
    return null;
  }

  if (answeredStage === "problem" || answeredStage === "project_type") {
    if (indicatesStructuralEmergency(text)) {
      const phrase = "I've noted this as urgent.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    if (indicatesWaterIntrusion(text) || detectEmergency(text)) {
      const phrase = buildEmergencyResponse();
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    return null;
  }

  if (answeredStage === "active_leak") {
    const yesNo = extractYesNo(answerText);
    if (yesNo && isYesValue(yesNo)) {
      const phrase = buildEmergencyResponse();
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    return null;
  }

  if (answeredStage === "storm_damage") {
    return null;
  }

  return null;
}

function pickTransitionPrefix(
  answeredStage: CollectionStage,
  answerText: string,
  newlyFilledCount: number,
  priorPhrases: string[],
): string | null {
  if (newlyFilledCount > 1) {
    return null;
  }

  const empathy = pickContextualEmpathy(answeredStage, answerText, priorPhrases);
  if (empathy) {
    return empathy;
  }

  return null;
}

export function getStageQuestion(
  stage: ConversationStage,
  fields: CollectedFields = {},
  callerPhone?: string,
): string | null {
  const firstName = fieldText(fields.full_name)?.split(/\s+/)[0];

  switch (stage) {
    case "problem":
      return "What's happening with the roof?";
    case "full_name":
      return "What's your name?";
    case "callback_phone":
      if (firstName) {
        return callerPhone
          ? `${firstName}, is this number the best one to reach you?`
          : `What's the best number to reach you, ${firstName}?`;
      }
      return callerPhone
        ? "Is this number the best one to reach you?"
        : "What's the best phone number to reach you?";
    case "address":
      return "What address should we inspect?";
    case "project_type":
      if (fields.address) {
        return "Are you looking for repair, replacement, an inspection, or help with storm damage?";
      }
      return "Are you looking for a repair, replacement, inspection, or help with storm damage?";
    case "active_leak":
      return "Is water getting inside the home right now?";
    case "storm_damage":
      if (
        fields.project_type?.toLowerCase().includes("storm") ||
        fields.storm_damage === "yes"
      ) {
        return "Was this from recent storm damage?";
      }
      return "Was this from recent storm damage?";
    case "insurance_claim":
      if (
        fields.storm_damage === "yes" ||
        fields.project_type?.toLowerCase().includes("storm")
      ) {
        return "Have you already started an insurance claim for this damage?";
      }
      return "Have you already started an insurance claim for this damage, or not yet?";
    case "urgency":
      if (fields.active_leak === "yes" || fields.urgency === "emergency") {
        return "How soon do you need someone on-site?";
      }
      return "How soon do you need someone out?";
    case "appointment":
      return "What day and time works best for someone to stop by?";
    case "additional_notes":
      return "Is there anything else our team should know?";
    default:
      return null;
  }
}

export function buildIntakeResponse(
  fields: CollectedFields,
  answeredStage: CollectionStage | "wrap_up",
  options: {
    callerPhone?: string;
    turnIndex?: number;
    fieldsBefore?: CollectedFields;
    callerAnswer?: string;
    priorPhrases?: string[];
  } = {},
): string {
  const nextStage = getNextMissingStage(fields);

  if (nextStage === "wrap_up") {
    return buildWrapUpSummary(fields);
  }

  const question =
    getStageQuestion(nextStage, fields, options.callerPhone) ??
    "Sorry, could you say that once more?";

  const newlyFilledCount = options.fieldsBefore
    ? countNewlyFilledFields(options.fieldsBefore, fields)
    : 1;

  if (answeredStage === "wrap_up") {
    return question;
  }

  const empathy = pickTransitionPrefix(
    answeredStage,
    options.callerAnswer ?? "",
    newlyFilledCount,
    options.priorPhrases ?? [],
  );

  return buildCombinedResponse([empathy], question);
}

export function buildWrapUpSummary(fields: CollectedFields): string {
  return buildSpokenCallSummary(fields);
}

export function buildConfirmedGoodbye(): string {
  return (
    "Perfect. Everything has been sent to our roofing team. " +
    "Someone will be reaching out shortly to confirm the next steps. " +
    "We appreciate you calling Beau's Roofing, and have a great day."
  );
}

export function buildCorrectionGoodbye(): string {
  return (
    "Thank you for clarifying. I'll send this to our team so someone can follow up with the correct details. " +
    "We appreciate you calling Beau's Roofing. Have a great day!"
  );
}

export function getRecentAssistantPhrases(
  transcript: Array<{ role: string; content: string }> | null | undefined,
): string[] {
  if (!transcript) {
    return [];
  }

  return transcript
    .filter((entry) => entry.role === "assistant")
    .slice(-4)
    .map((entry) => entry.content);
}

export function formatCollectedFields(fields: CollectedFields): string {
  return buildCrmCallSummary(fields);
}
