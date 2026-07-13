import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadProjectType } from "@/lib/leads";

export type PublicIntakeCompany = {
  id: string;
  company_name: string;
};

export type IntakeUrgency = "emergency" | "standard" | "flexible";

export type IntakeAnswers = {
  full_name: string;
  phone: string;
  email: string;
  address_line_1: string;
  city: string;
  state: string;
  postal_code: string;
  project_type: LeadProjectType | "";
  storm_damage_details: string;
  description: string;
  insurance_claim: boolean | null;
  adjuster_contacted: boolean | null;
  urgency: IntakeUrgency | "";
  preferred_contact: string;
};

export type IntakeStepId =
  | "welcome"
  | "full_name"
  | "phone"
  | "email"
  | "address_line_1"
  | "city"
  | "state"
  | "postal_code"
  | "project_type"
  | "storm_damage_details"
  | "description"
  | "insurance_claim"
  | "adjuster_contacted"
  | "urgency"
  | "emergency_notice"
  | "preferred_contact"
  | "review";

export const EMPTY_INTAKE_ANSWERS: IntakeAnswers = {
  full_name: "",
  phone: "",
  email: "",
  address_line_1: "",
  city: "",
  state: "",
  postal_code: "",
  project_type: "",
  storm_damage_details: "",
  description: "",
  insurance_claim: null,
  adjuster_contacted: null,
  urgency: "",
  preferred_contact: "",
};

export const INTAKE_PROJECT_TYPE_OPTIONS = [
  { value: "repair", label: "Repair" },
  { value: "replacement", label: "Replacement" },
  { value: "inspection", label: "Inspection" },
  { value: "storm_damage", label: "Storm damage" },
  { value: "other", label: "Other" },
] as const;

export const INTAKE_URGENCY_OPTIONS = [
  { value: "standard", label: "Standard — within a few days" },
  { value: "flexible", label: "Flexible — no rush" },
  { value: "emergency", label: "Emergency — urgent roof issue" },
] as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getIntakeSteps(answers: IntakeAnswers): IntakeStepId[] {
  const steps: IntakeStepId[] = [
    "welcome",
    "full_name",
    "phone",
    "email",
    "address_line_1",
    "city",
    "state",
    "postal_code",
    "project_type",
  ];

  if (answers.project_type === "storm_damage") {
    steps.push("storm_damage_details");
  }

  steps.push("description", "insurance_claim");

  if (answers.insurance_claim === true) {
    steps.push("adjuster_contacted");
  }

  steps.push("urgency");

  if (answers.urgency === "emergency") {
    steps.push("emergency_notice");
  }

  steps.push("preferred_contact", "review");

  return steps;
}

export function getIntakeStepPrompt(step: IntakeStepId): string {
  switch (step) {
    case "welcome":
      return "Welcome";
    case "full_name":
      return "What is your full name?";
    case "phone":
      return "What is the best phone number to reach you?";
    case "email":
      return "What is your email address? (optional)";
    case "address_line_1":
      return "What is the property address?";
    case "city":
      return "What city is the property in?";
    case "state":
      return "What state is the property in?";
    case "postal_code":
      return "What is the postal code?";
    case "project_type":
      return "What type of roofing project is this?";
    case "storm_damage_details":
      return "Please describe the storm damage briefly.";
    case "description":
      return "Please describe the issue or project details.";
    case "insurance_claim":
      return "Is this related to an insurance claim?";
    case "adjuster_contacted":
      return "Have you contacted your insurance adjuster yet?";
    case "urgency":
      return "How urgent is this request?";
    case "emergency_notice":
      return "Important emergency notice";
    case "preferred_contact":
      return "Preferred appointment date or contact time (optional)";
    case "review":
      return "Review your request";
    default:
      return "";
  }
}

export function formatIntakeAnswerLabel(key: keyof IntakeAnswers): string {
  const labels: Record<keyof IntakeAnswers, string> = {
    full_name: "Full name",
    phone: "Phone",
    email: "Email",
    address_line_1: "Property address",
    city: "City",
    state: "State",
    postal_code: "Postal code",
    project_type: "Project type",
    storm_damage_details: "Storm damage details",
    description: "Description",
    insurance_claim: "Insurance claim",
    adjuster_contacted: "Adjuster contacted",
    urgency: "Urgency",
    preferred_contact: "Preferred contact time",
  };

  return labels[key];
}

export function formatIntakeAnswerValue(
  key: keyof IntakeAnswers,
  answers: IntakeAnswers,
): string {
  const value = answers[key];

  if (value === null || value === "") {
    return "Not provided";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (key === "project_type") {
    return (
      INTAKE_PROJECT_TYPE_OPTIONS.find((option) => option.value === value)
        ?.label ?? value
    );
  }

  if (key === "urgency") {
    return (
      INTAKE_URGENCY_OPTIONS.find((option) => option.value === value)?.label ??
      value
    );
  }

  return String(value);
}

export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isValidIntakePhone(phone: string): boolean {
  const digits = normalizePhoneDigits(phone);
  return digits.length >= 10 && digits.length <= 15;
}

export function isValidIntakeEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

export function buildIntakeDescription(answers: IntakeAnswers): string {
  const lines: string[] = [];

  if (answers.urgency) {
    lines.push(`[Urgency: ${answers.urgency}]`);
  }

  if (answers.insurance_claim && answers.adjuster_contacted !== null) {
    lines.push(
      `[Insurance adjuster contacted: ${answers.adjuster_contacted ? "Yes" : "No"}]`,
    );
  }

  if (answers.storm_damage_details.trim()) {
    lines.push(`[Storm damage details: ${answers.storm_damage_details.trim()}]`);
  }

  lines.push("");
  lines.push(answers.description.trim());

  if (answers.preferred_contact.trim()) {
    lines.push("");
    lines.push(`[Preferred contact: ${answers.preferred_contact.trim()}]`);
  }

  return lines.join("\n").trim();
}

export function parsePreferredAppointmentAt(
  preferredContact: string,
): string | null {
  const trimmed = preferredContact.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

export function validateIntakeSubmission(answers: IntakeAnswers): string | null {
  if (!answers.full_name.trim()) {
    return "Full name is required.";
  }

  if (!isValidIntakePhone(answers.phone)) {
    return "Please enter a valid phone number.";
  }

  if (answers.email.trim() && !isValidIntakeEmail(answers.email)) {
    return "Please enter a valid email address.";
  }

  if (!answers.address_line_1.trim()) {
    return "Property address is required.";
  }

  if (!answers.project_type) {
    return "Project type is required.";
  }

  if (
    answers.project_type === "storm_damage" &&
    !answers.storm_damage_details.trim()
  ) {
    return "Please describe the storm damage.";
  }

  if (!answers.description.trim()) {
    return "Description is required.";
  }

  if (answers.insurance_claim === null) {
    return "Please indicate whether this is an insurance claim.";
  }

  if (answers.insurance_claim && answers.adjuster_contacted === null) {
    return "Please indicate whether an adjuster has been contacted.";
  }

  if (!answers.urgency) {
    return "Please select an urgency level.";
  }

  return null;
}

export function getPublicIntakePath(companyId: string): string {
  return `/intake/${companyId}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCompanyId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isMissingRpcFunctionError(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST202" ||
    (typeof error.message === "string" &&
      error.message.includes("Could not find the function"))
  );
}

async function getPublicIntakeCompanyFromCompanies(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PublicIntakeCompany | null> {
  const { data, error } = await supabase
    .from("companies")
    .select("id, company_name")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    return null;
  }

  if (!data?.id || !data.company_name) {
    return null;
  }

  return {
    id: data.id,
    company_name: data.company_name,
  };
}

async function getPublicIntakeCompanyFromProfiles(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PublicIntakeCompany | null> {
  const { data, error } = await supabase
    .from("company_intake_profiles")
    .select("id, company_name")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    return null;
  }

  if (!data?.id || !data.company_name) {
    return null;
  }

  return {
    id: data.id,
    company_name: data.company_name,
  };
}

async function getPublicIntakeCompanyFromView(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PublicIntakeCompany | null> {
  const { data, error } = await supabase
    .from("intake_companies_public")
    .select("id, company_name")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    return null;
  }

  if (!data?.id || !data.company_name) {
    return null;
  }

  return {
    id: data.id,
    company_name: data.company_name,
  };
}

export async function getPublicIntakeCompany(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PublicIntakeCompany | null> {
  const normalizedCompanyId = companyId.trim();

  if (!isValidCompanyId(normalizedCompanyId)) {
    return null;
  }

  const { data, error } = await supabase.rpc("get_public_intake_company", {
    p_company_id: normalizedCompanyId,
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;

    if (row?.id && row?.company_name) {
      return {
        id: row.id,
        company_name: row.company_name,
      };
    }
  }

  const profileCompany = await getPublicIntakeCompanyFromProfiles(
    supabase,
    normalizedCompanyId,
  );

  if (profileCompany) {
    return profileCompany;
  }

  const viewCompany = await getPublicIntakeCompanyFromView(
    supabase,
    normalizedCompanyId,
  );

  if (viewCompany) {
    return viewCompany;
  }

  return getPublicIntakeCompanyFromCompanies(supabase, normalizedCompanyId);
}

export async function createWebsiteIntakeLead(
  supabase: SupabaseClient,
  companyId: string,
  answers: IntakeAnswers,
): Promise<string> {
  const validationError = validateIntakeSubmission(answers);

  if (validationError) {
    throw new Error(validationError);
  }

  const description = buildIntakeDescription(answers);
  const appointmentAt = parsePreferredAppointmentAt(answers.preferred_contact);

  const { data, error } = await supabase.rpc("create_website_intake_lead", {
    p_company_id: companyId,
    p_full_name: answers.full_name.trim(),
    p_phone: answers.phone.trim(),
    p_email: answers.email.trim() || null,
    p_address_line_1: answers.address_line_1.trim(),
    p_city: answers.city.trim(),
    p_state: answers.state.trim(),
    p_postal_code: answers.postal_code.trim(),
    p_project_type: answers.project_type,
    p_description: description,
    p_insurance_claim: answers.insurance_claim === true,
    p_appointment_at: appointmentAt,
  });

  if (error) {
    if (isMissingRpcFunctionError(error)) {
      throw new Error(
        "Website intake is not configured yet. Run supabase/phase_12_website_intake.sql in Supabase.",
      );
    }

    throw error;
  }

  if (!data) {
    throw new Error("Failed to create intake lead.");
  }

  return String(data);
}
