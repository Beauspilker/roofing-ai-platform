import { OPENING_GREETING } from "@/lib/twilio/helpers";

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
};

type IntakeFieldKey = Exclude<
  keyof CollectedFields,
  "summary_delivered" | "summary_confirmed"
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

function isUrgentProblem(text: string): boolean {
  return /leak|leaking|water|emergency|urgent|damage|hole|dripping|flooding|collapsed|hail|storm/i.test(
    text,
  );
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

  if (normalized.includes("storm")) {
    return "storm damage";
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
  const answeringStage = getNextMissingStage(fields);
  const updated: CollectedFields = { ...fields };
  const extracted = extractFieldsFromSpeech(answer, callerPhone);

  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    const extractedValue = extracted[fieldKey];

    if (!hasValue(updated[fieldKey]) && hasValue(extractedValue)) {
      updated[fieldKey] = extractedValue;
    }
  }

  if (answeringStage !== "wrap_up") {
    const primaryKey = STAGE_FIELD_KEYS[answeringStage];

    if (!hasValue(updated[primaryKey])) {
      updated[primaryKey] = normalizeFieldValue(
        answeringStage,
        answer,
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
      const phrase = "That definitely sounds urgent.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    if (indicatesWaterIntrusion(text)) {
      const phrase = "We'll make sure that gets marked as urgent.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    if (/emergency|urgent|asap|right away|immediately|needs attention/i.test(text)) {
      const phrase = "It sounds like that needs attention quickly.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    if (indicatesStormDamage(text) || isUrgentProblem(text)) {
      const phrase = "Thanks for letting me know.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    return null;
  }

  if (answeredStage === "active_leak") {
    const yesNo = extractYesNo(answerText);
    if (yesNo && isYesValue(yesNo)) {
      const phrase = "We'll make sure that gets marked as urgent.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

    return null;
  }

  if (answeredStage === "storm_damage") {
    const yesNo = extractYesNo(answerText);
    if (yesNo && isYesValue(yesNo)) {
      const phrase = "Thanks for letting me know.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }

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
  switch (stage) {
    case "problem":
      return "What's happening with the roof?";
    case "full_name":
      return "What's your name?";
    case "callback_phone":
      return callerPhone
        ? "What's the best number to reach you — is this one okay?"
        : "What's the best phone number to reach you?";
    case "address":
      return "What address would you like us to inspect?";
    case "project_type":
      return "Are you looking for a repair, replacement, inspection, or help with storm damage?";
    case "active_leak":
      return "Is water currently getting inside your home?";
    case "storm_damage":
      return "Was this from recent storm damage?";
    case "insurance_claim":
      return "Have you already started an insurance claim, or not yet?";
    case "urgency":
      return "How soon do you need someone out — is it an emergency, or more standard timing?";
    case "appointment":
      return "What day and time usually works best for someone to stop by?";
    case "additional_notes":
      return "Is there anything else you'd like our team to know?";
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

  const prefix = pickTransitionPrefix(
    answeredStage,
    options.callerAnswer ?? "",
    newlyFilledCount,
    options.priorPhrases ?? [],
  );

  if (prefix) {
    return `${prefix} ${question}`;
  }

  return question;
}

function formatPhoneForSpeech(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);

  if (digits.length !== 10) {
    return phone;
  }

  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function describeUrgency(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (normalized.includes("emergency")) {
    return "We'll treat this as urgent.";
  }
  if (normalized.includes("flexible")) {
    return "Timing sounds flexible on your end.";
  }
  if (normalized.includes("standard")) {
    return "Standard timing works for you.";
  }

  return null;
}

function buildSummaryLead(fields: CollectedFields): string {
  const problem = fieldText(fields.problem_description);
  const projectType = fieldText(fields.project_type);
  const address = fieldText(fields.address);

  if (problem && address) {
    return `You're calling about ${problem} at ${address}.`;
  }

  if (problem) {
    const projectHint =
      projectType && !problem.toLowerCase().includes(projectType.toLowerCase())
        ? ` related to ${projectType}`
        : "";
    return `You're calling about ${problem}${projectHint}.`;
  }

  if (projectType && address) {
    return `You're calling about ${projectType} at ${address}.`;
  }

  if (projectType) {
    return `You're calling about ${projectType}.`;
  }

  if (address) {
    return `You'd like us to take a look at ${address}.`;
  }

  return "I have the details of your request.";
}

export function buildWrapUpSummary(fields: CollectedFields): string {
  const fullName = fieldText(fields.full_name);
  const callbackPhone = fieldText(fields.callback_phone);
  const activeLeak = fieldText(fields.active_leak);
  const stormDamage = fieldText(fields.storm_damage);
  const insuranceClaim = fieldText(fields.insurance_claim);
  const urgency = fieldText(fields.urgency);
  const appointment = fieldText(fields.appointment_preference);
  const additionalNotes = fieldText(fields.additional_notes);

  const narrative: string[] = ["Perfect.", "Here's what I have.", buildSummaryLead(fields)];

  if (fullName) {
    narrative.push(`I have you as ${fullName}.`);
  }

  if (callbackPhone) {
    narrative.push(`We'll reach you at ${formatPhoneForSpeech(callbackPhone)}.`);
  }

  if (isYesValue(activeLeak)) {
    narrative.push("Water has started coming inside.");
  } else if (isNoValue(activeLeak)) {
    narrative.push("There's no water coming inside right now.");
  }

  if (isYesValue(stormDamage)) {
    narrative.push("This sounds storm-related.");
  }

  if (isYesValue(insuranceClaim)) {
    narrative.push("You've already started an insurance claim.");
  } else if (isNoValue(insuranceClaim)) {
    narrative.push("You haven't opened an insurance claim yet.");
  }

  const urgencyPhrase = describeUrgency(urgency);
  if (urgencyPhrase) {
    narrative.push(urgencyPhrase);
  }

  if (appointment) {
    narrative.push(`You'd like someone to come out ${appointment}.`);
  }

  if (additionalNotes && additionalNotes.toLowerCase() !== "none") {
    narrative.push(`You also mentioned ${additionalNotes}.`);
  }

  return `${narrative.join(" ")} Does all of that sound correct?`;
}

export function buildConfirmedGoodbye(): string {
  return (
    "Perfect. I'll send this over to our roofing team right away. " +
    "Someone should be reaching out soon to confirm everything. " +
    "Thank you for calling Beau's Roofing. Have a great day!"
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
  const lines: string[] = [];
  const entries: Array<[string, string | null]> = [
    ["Roof issue", fieldText(fields.problem_description)],
    ["Name", fieldText(fields.full_name)],
    ["Callback phone", fieldText(fields.callback_phone)],
    ["Address", fieldText(fields.address)],
    ["Project type", fieldText(fields.project_type)],
    ["Active leak", fieldText(fields.active_leak)],
    ["Storm damage", fieldText(fields.storm_damage)],
    ["Insurance claim", fieldText(fields.insurance_claim)],
    ["Urgency", fieldText(fields.urgency)],
    ["Appointment preference", fieldText(fields.appointment_preference)],
    ["Additional notes", fieldText(fields.additional_notes)],
  ];

  for (const [label, value] of entries) {
    if (value) {
      lines.push(`- ${label}: ${value}`);
    }
  }

  return lines.join("\n");
}
