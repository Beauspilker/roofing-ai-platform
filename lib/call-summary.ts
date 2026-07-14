export type SummaryFields = {
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
};

export type SummaryFieldKey = Exclude<
  keyof SummaryFields,
  never
>;

const SUMMARY_DATA_FIELDS = new Set<string>([
  "problem_description",
  "full_name",
  "callback_phone",
  "address",
  "project_type",
  "active_leak",
  "storm_damage",
  "insurance_claim",
  "urgency",
  "appointment_preference",
  "additional_notes",
]);

export function isSummaryDataField(
  field: string,
): field is SummaryFieldKey {
  return SUMMARY_DATA_FIELDS.has(field);
}

const FILLER_WORDS =
  /\b(uh+|um+|uh huh|you know|i mean|kind of|sort of|like|basically|literally|anyway)\b/gi;

const OPENING_FILLER =
  /^(hey|hi|hello|yeah|yep|so|well|okay|ok|thanks|thank you)[,.]?\s+/i;

const CALL_PREFIX =
  /^(i'?m calling because|calling because|i wanted to (call|see|ask)|i need to (report|tell you about|let you know))\s+/i;

const UNCERTAIN_PHRASES =
  /\b(i think|hopefully|maybe|probably|it sounds like|sounds like|i guess|i believe|i feel like)\b/gi;

const SUMMARY_CONFIRMATION = "Does all of that sound correct?";

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isYes(value: string | undefined): boolean {
  return hasText(value) && /^(yes|yeah|yep|yup|true|correct|sure)$/i.test(value.trim());
}

function isNo(value: string | undefined): boolean {
  return hasText(value) && /^(no|nope|nah|false|none|not|negative)$/i.test(value.trim());
}

function capitalize(text: string): string {
  if (!text) {
    return text;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function stripConversationalFiller(text: string): string {
  let cleaned = text.trim();

  for (let pass = 0; pass < 3; pass += 1) {
    cleaned = cleaned
      .replace(OPENING_FILLER, "")
      .replace(CALL_PREFIX, "")
      .replace(UNCERTAIN_PHRASES, "")
      .replace(FILLER_WORDS, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return cleaned.replace(/[,.]$/, "").trim();
}

function extractDamageTiming(text: string): string | null {
  const lower = text.toLowerCase();

  if (/\byesterday\b/.test(lower)) {
    return "yesterday";
  }
  if (/\blast night\b/.test(lower)) {
    return "last night";
  }
  if (/\bthis morning\b/.test(lower)) {
    return "this morning";
  }
  if (/\btoday\b/.test(lower)) {
    return "today";
  }
  if (/\blast week\b/.test(lower)) {
    return "last week";
  }
  if (/\brecent(ly)?\b/.test(lower)) {
    return "recently";
  }

  return null;
}

function extractLeakLocation(text: string): string | null {
  const match = text.match(
    /\b(?:into|in|affecting)\s+(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)\b/i,
  );

  if (match?.[1] && !/home|house|property|inside/.test(match[1])) {
    return match[1].trim();
  }

  const roomMatch = text.match(
    /\b(kitchen|bathroom|bedroom|living room|garage|basement|attic|dining room)\b/i,
  );

  return roomMatch?.[1]?.trim() ?? null;
}

function professionalizeFreeText(text: string): string {
  const cleaned = stripConversationalFiller(text);

  if (!cleaned) {
    return "";
  }

  return cleaned
    .replace(/\bmessed up\b/gi, "damaged")
    .replace(/\bgot hit really bad\b/gi, "sustained significant damage")
    .replace(/\bhit really bad\b/gi, "sustained significant damage")
    .replace(/\bstarted leaking\b/gi, "water intrusion began")
    .replace(/\bleaking\b/gi, "water intrusion")
    .replace(/\bfiled an insurance claim\b/gi, "insurance claim started")
    .replace(/\bneed someone to come\b/gi, "inspection requested")
    .replace(/\bjust need\b/gi, "requested")
    .trim();
}

function summarizeDamageReason(fields: SummaryFields): string | null {
  const problem = hasText(fields.problem_description)
    ? stripConversationalFiller(fields.problem_description)
    : "";
  const projectType = fields.project_type?.trim().toLowerCase() ?? "";
  const lower = problem.toLowerCase();
  const timing = extractDamageTiming(problem);

  if (/hail/.test(lower) || projectType === "storm damage") {
    return timing
      ? `Suspected hail damage that occurred ${timing}`
      : "Suspected hail damage";
  }

  if (/wind/.test(lower) || projectType === "wind damage") {
    return timing
      ? `Suspected wind damage that occurred ${timing}`
      : "Suspected wind damage";
  }

  if (/tree|through the roof|collapse|caved/.test(lower)) {
    return "Structural roof damage requiring urgent attention";
  }

  if (/tornado|hurricane|storm/.test(lower) || fields.storm_damage === "yes") {
    return timing
      ? `Storm-related roof damage reported ${timing}`
      : "Storm-related roof damage";
  }

  if (projectType === "replacement") {
    return "Roof replacement inquiry";
  }

  if (projectType === "repair") {
    return "Roof repair request";
  }

  if (projectType === "inspection") {
    return "Roof inspection request";
  }

  if (problem) {
    const professional = professionalizeFreeText(problem);
    if (professional) {
      return capitalize(professional);
    }
  }

  if (projectType) {
    return capitalize(`${projectType} inquiry`);
  }

  return null;
}

function summarizeLeak(fields: SummaryFields): string | null {
  const problem = fields.problem_description ?? "";
  const notes = fields.additional_notes ?? "";
  const combined = `${problem} ${notes}`.toLowerCase();

  if (!isYes(fields.active_leak) && !/leak|water|pouring|drip/.test(combined)) {
    if (isNo(fields.active_leak)) {
      return "No active interior water intrusion reported";
    }
    return null;
  }

  const location = extractLeakLocation(`${problem} ${notes}`);

  if (location) {
    return `Interior water intrusion affecting the ${location}`;
  }

  return "Active interior water intrusion reported";
}

function summarizeInsurance(fields: SummaryFields): string | null {
  if (isYes(fields.insurance_claim)) {
    return "Insurance claim has already been started";
  }

  if (isNo(fields.insurance_claim)) {
    return "Insurance claim has not been started";
  }

  return null;
}

function summarizeAppointment(fields: SummaryFields): string | null {
  const raw = fields.appointment_preference;

  if (!hasText(raw) || raw.toLowerCase() === "none") {
    return null;
  }

  let cleaned = stripConversationalFiller(raw)
    .replace(/^i just need someone to come\b/i, "")
    .replace(/^i need someone (out|to come)\b/i, "")
    .replace(/^someone to come\b/i, "")
    .replace(/^please come\b/i, "")
    .trim();

  if (!cleaned) {
    cleaned = raw.trim();
  }

  if (/^(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(cleaned)) {
    return `Requested inspection ${cleaned.toLowerCase()}`;
  }

  return `Requested inspection: ${cleaned}`;
}

function summarizeUrgency(fields: SummaryFields): string | null {
  const urgency = fields.urgency?.trim().toLowerCase();

  if (!urgency) {
    return null;
  }

  if (urgency === "emergency") {
    return "Marked as urgent priority";
  }

  if (urgency === "flexible") {
    return "Flexible scheduling noted";
  }

  return "Standard scheduling requested";
}

function summarizeAdditionalNotes(fields: SummaryFields): string | null {
  const notes = fields.additional_notes;

  if (!hasText(notes) || notes.toLowerCase() === "none") {
    return null;
  }

  const professional = professionalizeFreeText(notes);
  return professional ? capitalize(professional) : null;
}

export type ProfessionalSummaryContent = {
  reason: string | null;
  contactName: string | null;
  location: string | null;
  leak: string | null;
  insurance: string | null;
  urgency: string | null;
  appointment: string | null;
  additionalNotes: string | null;
};

export function buildProfessionalSummaryContent(
  fields: SummaryFields,
): ProfessionalSummaryContent {
  return {
    reason: summarizeDamageReason(fields),
    contactName: hasText(fields.full_name) ? fields.full_name.trim() : null,
    location: hasText(fields.address) ? fields.address.trim() : null,
    leak: summarizeLeak(fields),
    insurance: summarizeInsurance(fields),
    urgency: summarizeUrgency(fields),
    appointment: summarizeAppointment(fields),
    additionalNotes: summarizeAdditionalNotes(fields),
  };
}

function reasonToSpoken(reason: string): string {
  return reason
    .replace(/^Suspected /, "suspected ")
    .replace(/^Storm-related /, "storm-related ")
    .replace(/^Structural /, "structural ")
    .replace(/^Roof /, "roof ")
    .replace(/^Insurance /, "insurance ");
}

function appointmentToSpoken(appointment: string): string {
  const lower = appointment.toLowerCase();

  if (lower.startsWith("requested inspection ")) {
    const detail = appointment.slice("Requested inspection ".length);
    return `You'd like someone to come ${detail}.`;
  }

  if (lower.startsWith("requested inspection:")) {
    const detail = appointment.slice("Requested inspection:".length).trim();
    return `You'd like someone to come ${detail}.`;
  }

  return `You'd like someone to come ${appointment.toLowerCase()}.`;
}

function insuranceToSpoken(insurance: string): string {
  if (insurance.includes("already been started")) {
    return "You've already started an insurance claim.";
  }

  if (insurance.includes("not been started")) {
    return "You haven't started an insurance claim yet.";
  }

  return insurance;
}

function leakToSpoken(leak: string): string {
  if (leak.includes("Interior water intrusion affecting")) {
    const location = leak.replace("Interior water intrusion affecting the ", "");
    return `I've also noted that water has begun leaking into the ${location}.`;
  }

  if (leak.includes("Active interior water intrusion")) {
    return "I've also noted that water has begun coming inside.";
  }

  if (leak.includes("No active interior")) {
    return "There's no water coming inside right now.";
  }

  return leak;
}

export function buildSpokenCallSummary(fields: SummaryFields): string {
  const content = buildProfessionalSummaryContent(fields);
  const lines: string[] = ["Here's what I have."];

  if (content.reason) {
    lines.push(`You're calling about ${reasonToSpoken(content.reason)}.`);
  }

  if (content.location) {
    lines.push(`We'll be inspecting the property at ${content.location}.`);
  }

  if (content.contactName && !content.location) {
    lines.push(`I have you as ${content.contactName}.`);
  }

  if (content.insurance) {
    lines.push(insuranceToSpoken(content.insurance));
  }

  if (content.appointment) {
    lines.push(appointmentToSpoken(content.appointment));
  }

  if (content.leak) {
    lines.push(leakToSpoken(content.leak));
  }

  if (content.urgency && content.urgency.includes("urgent")) {
    lines.push("I've marked this as urgent for our team.");
  }

  if (content.additionalNotes) {
    lines.push(`I've also noted ${content.additionalNotes.toLowerCase()}.`);
  }

  return `${lines.join(" ")} ${SUMMARY_CONFIRMATION}`;
}

export function buildCrmCallSummary(fields: SummaryFields): string {
  const content = buildProfessionalSummaryContent(fields);
  const lines: string[] = [];

  if (content.reason) {
    lines.push(`Reason: ${content.reason}`);
  }

  if (content.contactName) {
    lines.push(`Contact: ${content.contactName}`);
  }

  if (hasText(fields.callback_phone)) {
    lines.push(`Phone: ${fields.callback_phone.trim()}`);
  }

  if (content.location) {
    lines.push(`Property: ${content.location}`);
  }

  if (content.leak) {
    lines.push(`Water intrusion: ${content.leak}`);
  }

  if (content.insurance) {
    lines.push(`Insurance: ${content.insurance}`);
  }

  if (content.urgency) {
    lines.push(`Priority: ${content.urgency}`);
  }

  if (content.appointment) {
    lines.push(`Scheduling: ${content.appointment}`);
  }

  if (content.additionalNotes) {
    lines.push(`Notes: ${content.additionalNotes}`);
  }

  return lines.join("\n");
}

function fieldUpdateLine(
  field: keyof SummaryFields,
  fields: SummaryFields,
): string | null {
  const content = buildProfessionalSummaryContent(fields);

  switch (field) {
    case "full_name":
      return content.contactName
        ? `I've updated the contact name to ${content.contactName}.`
        : null;
    case "callback_phone":
      return hasText(fields.callback_phone)
        ? `I've updated the callback number.`
        : null;
    case "address":
      return content.location
        ? `I've updated the inspection address to ${content.location}.`
        : null;
    case "problem_description":
    case "project_type":
    case "storm_damage":
      return content.reason
        ? `I've updated the damage details to ${reasonToSpoken(content.reason).replace(/\.$/, "")}.`
        : null;
    case "active_leak":
      return content.leak ? `I've noted ${content.leak.toLowerCase()}.` : null;
    case "insurance_claim":
      return content.insurance
        ? `I've updated this — ${content.insurance.toLowerCase()}.`
        : null;
    case "urgency":
      return content.urgency
        ? `I've updated the priority — ${content.urgency.toLowerCase()}.`
        : null;
    case "appointment_preference": {
      if (!content.appointment) {
        return null;
      }

      const detail = content.appointment
        .replace(/^Requested inspection:?\s*/i, "")
        .toLowerCase();
      return `I've updated the appointment to ${detail}.`;
    }
    case "additional_notes":
      return content.additionalNotes
        ? `I've added that note — ${content.additionalNotes.toLowerCase()}.`
        : null;
    default:
      return null;
  }
}

export function buildSummaryFieldUpdateReply(
  field: keyof SummaryFields,
  fields: SummaryFields,
): string {
  const updateLine = fieldUpdateLine(field, fields);

  if (updateLine) {
    return `Absolutely. ${updateLine} Everything else stays the same. Anything else you'd like to change?`;
  }

  return "Absolutely. I've updated that. Everything else stays the same. Anything else you'd like to change?";
}

export function getSummaryConfirmationPrompt(): string {
  return SUMMARY_CONFIRMATION;
}
