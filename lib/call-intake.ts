import { ROOF_QUESTION } from "@/lib/twilio/helpers";

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
};

type IntakeFieldKey = Exclude<
  keyof CollectedFields,
  "summary_delivered"
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

const ACKNOWLEDGMENTS = [
  "Thanks.",
  "Okay.",
  "Understood.",
  "Perfect.",
  "That helps.",
  "Alright.",
] as const;

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function fieldText(value: string | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim();
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

function pickAcknowledgment(
  answeredStage: CollectionStage,
  newlyFilledCount: number,
  turnIndex: number,
): string | null {
  if (newlyFilledCount > 1) {
    return null;
  }

  if (answeredStage === "problem" || answeredStage === "additional_notes") {
    return null;
  }

  if (
    answeredStage === "active_leak" ||
    answeredStage === "storm_damage" ||
    answeredStage === "insurance_claim"
  ) {
    return turnIndex % 2 === 0 ? "Thanks." : null;
  }

  return ACKNOWLEDGMENTS[turnIndex % ACKNOWLEDGMENTS.length] ?? null;
}

export function getStageQuestion(
  stage: ConversationStage,
  fields: CollectedFields = {},
  callerPhone?: string,
): string | null {
  switch (stage) {
    case "problem":
      return ROOF_QUESTION;
    case "full_name":
      return "May I have your full name?";
    case "callback_phone":
      return callerPhone
        ? "Can we reach you at the number you're calling from, or what is the best callback number?"
        : "What is the best callback number for you?";
    case "address":
      return "What is the service address for the property?";
    case "project_type":
      return "Is this for a repair, replacement, inspection, or storm damage?";
    case "active_leak":
      return "Is there an active leak right now?";
    case "storm_damage":
      return "Was this caused by recent storm damage?";
    case "insurance_claim":
      return "Are you planning to file an insurance claim?";
    case "urgency":
      return "How urgent is this: emergency, standard, or flexible?";
    case "appointment":
      return "When would be a good time for us to come take a look?";
    case "additional_notes":
      return "Is there anything else we should know?";
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
  } = {},
): string {
  const nextStage = getNextMissingStage(fields);

  if (nextStage === "wrap_up") {
    return buildWrapUpSummary(fields);
  }

  const question =
    getStageQuestion(nextStage, fields, options.callerPhone) ??
    "Could you repeat that for me?";

  const newlyFilledCount = options.fieldsBefore
    ? countNewlyFilledFields(options.fieldsBefore, fields)
    : 1;

  if (answeredStage === "wrap_up") {
    return question;
  }

  const acknowledgment = pickAcknowledgment(
    answeredStage,
    newlyFilledCount,
    options.turnIndex ?? 0,
  );

  if (acknowledgment) {
    return `${acknowledgment} ${question}`;
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

export function buildWrapUpSummary(fields: CollectedFields): string {
  const details: string[] = [];
  const problem = fieldText(fields.problem_description);
  const fullName = fieldText(fields.full_name);
  const callbackPhone = fieldText(fields.callback_phone);
  const address = fieldText(fields.address);
  const projectType = fieldText(fields.project_type);
  const activeLeak = fieldText(fields.active_leak);
  const stormDamage = fieldText(fields.storm_damage);
  const insuranceClaim = fieldText(fields.insurance_claim);
  const urgency = fieldText(fields.urgency);
  const appointment = fieldText(fields.appointment_preference);
  const additionalNotes = fieldText(fields.additional_notes);

  if (problem) {
    details.push(`the issue is ${problem}`);
  }
  if (fullName) {
    details.push(`your name is ${fullName}`);
  }
  if (callbackPhone) {
    details.push(`we'll call you at ${formatPhoneForSpeech(callbackPhone)}`);
  }
  if (address) {
    details.push(`the property is at ${address}`);
  }
  if (projectType) {
    details.push(`this is a ${projectType} project`);
  }
  if (activeLeak) {
    details.push(`active leak: ${activeLeak}`);
  }
  if (stormDamage) {
    details.push(`storm damage: ${stormDamage}`);
  }
  if (insuranceClaim) {
    details.push(`insurance claim: ${insuranceClaim}`);
  }
  if (urgency) {
    details.push(`urgency is ${urgency}`);
  }
  if (appointment) {
    details.push(`you'd like us to come out ${appointment}`);
  }
  if (additionalNotes && additionalNotes.toLowerCase() !== "none") {
    details.push(`additional notes: ${additionalNotes}`);
  }

  const summaryBody =
    details.length > 0
      ? details.join(", ")
      : "we have your request on file";

  return (
    `Thanks. Let me confirm what I have: ${summaryBody}. ` +
    "Someone from Beau's Roofing will follow up to confirm your appointment. " +
    "Thank you for calling. Have a great day!"
  );
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
