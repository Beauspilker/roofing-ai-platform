import type { SupabaseClient } from "@supabase/supabase-js";

export type Lead = {
  id: string;
  company_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  source: string;
  status: string;
  project_type: string | null;
  description: string | null;
  insurance_claim: boolean;
  appointment_at: string | null;
  estimate_amount: number | null;
  estimate_sent_at: string | null;
  last_contacted_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LeadPriority = "high" | "medium" | "low";

export type LeadDashboardStats = {
  totalActiveLeads: number;
  newLeadsToday: number;
  highPriorityLeads: number;
  leadsAwaitingContact: number;
};

const INACTIVE_STATUSES = new Set(["won", "lost", "archived"]);

const PROJECT_TYPE_LABELS: Record<string, string> = {
  repair: "Repair",
  replacement: "Replacement",
  inspection: "Inspection",
  storm_damage: "Storm damage",
  other: "Other",
};

const SOURCE_LABELS: Record<string, string> = {
  ai_phone: "AI phone",
  website: "Website",
  referral: "Referral",
  manual: "Manual",
  other: "Other",
};

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  appointment_scheduled: "Appointment scheduled",
  estimate_sent: "Estimate sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
};

export const LEAD_SOURCES = [
  "ai_phone",
  "website",
  "referral",
  "manual",
  "other",
] as const;

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "appointment_scheduled",
  "estimate_sent",
  "won",
  "lost",
  "archived",
] as const;

export const LEAD_PROJECT_TYPES = [
  "repair",
  "replacement",
  "inspection",
  "storm_damage",
  "other",
] as const;

export const LEAD_PRIORITIES: LeadPriority[] = ["high", "medium", "low"];

export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadProjectType = (typeof LEAD_PROJECT_TYPES)[number];

export type CreateLeadInput = {
  full_name: string;
  phone?: string;
  email?: string;
  address_line_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  source: LeadSource;
  status: LeadStatus;
  project_type?: LeadProjectType;
  description?: string;
  insurance_claim: boolean;
};

export type UpdateLeadInput = CreateLeadInput & {
  appointment_at?: string | null;
};

export type LeadFormValues = {
  full_name: string;
  phone: string;
  email: string;
  address_line_1: string;
  city: string;
  state: string;
  postal_code: string;
  source: LeadSource;
  status: LeadStatus;
  project_type: string;
  description: string;
  insurance_claim: boolean;
  appointment_at: string;
  priority: LeadPriority;
};

export type LeadFormState = {
  error: string | null;
};

export function getLeadPriorityLabel(priority: LeadPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function isLeadSource(value: string): value is LeadSource {
  return LEAD_SOURCES.includes(value as LeadSource);
}

export function isLeadStatus(value: string): value is LeadStatus {
  return LEAD_STATUSES.includes(value as LeadStatus);
}

export function isLeadProjectType(value: string): value is LeadProjectType {
  return LEAD_PROJECT_TYPES.includes(value as LeadProjectType);
}

export function getProjectTypeLabel(projectType: string): string {
  return PROJECT_TYPE_LABELS[projectType] ?? projectType;
}

export function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function isActiveLead(lead: Lead): boolean {
  return !INACTIVE_STATUSES.has(lead.status);
}

export function isArchivedLead(lead: Lead): boolean {
  return lead.archived_at !== null || lead.status === "archived";
}

export function isDashboardActiveLead(lead: Lead): boolean {
  return !isArchivedLead(lead);
}

export function deriveLeadPriority(lead: Lead): LeadPriority {
  if (lead.insurance_claim || lead.project_type === "storm_damage") {
    return "high";
  }

  if (lead.description?.includes("[Urgency: emergency]")) {
    return "high";
  }

  if (lead.status === "new" && lead.last_contacted_at === null) {
    if (lead.source === "website") {
      return "medium";
    }

    return "high";
  }

  if (
    lead.status === "contacted" ||
    lead.status === "appointment_scheduled"
  ) {
    return "medium";
  }

  return "low";
}

export type LeadArchiveView = "active" | "archived" | "all";

export type LeadFilterValues = {
  search: string;
  status: LeadStatus | "all";
  priority: LeadPriority | "all";
  projectType: LeadProjectType | "all";
  source: LeadSource | "all";
  archiveView: LeadArchiveView;
};

export const DEFAULT_LEAD_FILTERS: LeadFilterValues = {
  search: "",
  status: "all",
  priority: "all",
  projectType: "all",
  source: "all",
  archiveView: "active",
};

function matchesArchiveView(lead: Lead, archiveView: LeadArchiveView): boolean {
  if (archiveView === "all") {
    return true;
  }

  if (archiveView === "archived") {
    return isArchivedLead(lead);
  }

  return !isArchivedLead(lead);
}

function leadMatchesSearch(lead: Lead, search: string): boolean {
  const query = search.trim().toLowerCase();

  if (!query) {
    return true;
  }

  const searchableFields = [
    lead.full_name,
    lead.phone,
    lead.email,
    lead.city,
    lead.address_line_1,
  ];

  return searchableFields.some((field) =>
    field?.toLowerCase().includes(query),
  );
}

export function filterLeads(
  leads: Lead[],
  filters: LeadFilterValues,
): Lead[] {
  return leads.filter((lead) => {
    if (!matchesArchiveView(lead, filters.archiveView)) {
      return false;
    }

    if (!leadMatchesSearch(lead, filters.search)) {
      return false;
    }

    if (filters.status !== "all" && lead.status !== filters.status) {
      return false;
    }

    if (
      filters.priority !== "all" &&
      deriveLeadPriority(lead) !== filters.priority
    ) {
      return false;
    }

    if (
      filters.projectType !== "all" &&
      lead.project_type !== filters.projectType
    ) {
      return false;
    }

    if (filters.source !== "all" && lead.source !== filters.source) {
      return false;
    }

    return true;
  });
}

export function isLeadAwaitingContact(lead: Lead): boolean {
  return lead.status === "new" && lead.last_contacted_at === null;
}

export function isNewLeadToday(lead: Lead, now = new Date()): boolean {
  const created = new Date(lead.created_at);

  return (
    created.getUTCFullYear() === now.getUTCFullYear() &&
    created.getUTCMonth() === now.getUTCMonth() &&
    created.getUTCDate() === now.getUTCDate()
  );
}

export function formatLeadAddress(lead: Lead): string {
  const cityState = [lead.city, lead.state].filter(Boolean).join(", ");
  const parts = [lead.address_line_1, cityState, lead.postal_code].filter(
    Boolean,
  );

  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function formatLeadCallType(lead: Lead): string {
  if (lead.project_type) {
    return PROJECT_TYPE_LABELS[lead.project_type] ?? lead.project_type;
  }

  return SOURCE_LABELS[lead.source] ?? lead.source;
}

export function formatLeadStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatLeadCreatedAt(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

export function formatLeadAppointmentAt(appointmentAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(appointmentAt));
}

export function formatLeadFieldValue(value: string | null | undefined): string {
  if (!value || value.trim().length === 0) {
    return "—";
  }

  return value;
}

export function formatInsuranceClaim(value: boolean): string {
  return value ? "Yes" : "No";
}

export function formatDateTimeLocalValue(iso: string | null): string {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function getLeadFormValues(lead: Lead): LeadFormValues {
  return {
    full_name: lead.full_name,
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    address_line_1: lead.address_line_1 ?? "",
    city: lead.city ?? "",
    state: lead.state ?? "",
    postal_code: lead.postal_code ?? "",
    source: lead.source as LeadSource,
    status: lead.status as LeadStatus,
    project_type: lead.project_type ?? "",
    description: lead.description ?? "",
    insurance_claim: lead.insurance_claim,
    appointment_at: formatDateTimeLocalValue(lead.appointment_at),
    priority: deriveLeadPriority(lead),
  };
}

export function parseLeadFormInput(
  formData: FormData,
): UpdateLeadInput | { error: string } {
  const fullName = formData.get("full_name")?.toString().trim() ?? "";
  const source = formData.get("source")?.toString() ?? "manual";
  const status = formData.get("status")?.toString() ?? "new";
  const projectType = formData.get("project_type")?.toString().trim() ?? "";
  const insuranceClaim = formData.get("insurance_claim") === "on";
  const appointmentRaw = formData.get("appointment_at")?.toString().trim() ?? "";

  if (!fullName) {
    return { error: "Full name is required." };
  }

  if (!isLeadSource(source)) {
    return { error: "Please select a valid source." };
  }

  if (!isLeadStatus(status)) {
    return { error: "Please select a valid status." };
  }

  if (projectType && !isLeadProjectType(projectType)) {
    return { error: "Please select a valid project type." };
  }

  let appointmentAt: string | null = null;
  if (appointmentRaw) {
    const parsedAppointment = new Date(appointmentRaw);
    if (Number.isNaN(parsedAppointment.getTime())) {
      return { error: "Please enter a valid appointment date." };
    }
    appointmentAt = parsedAppointment.toISOString();
  }

  const validatedProjectType = projectType
    ? (projectType as LeadProjectType)
    : undefined;

  return {
    full_name: fullName,
    phone: formData.get("phone")?.toString().trim() || undefined,
    email: formData.get("email")?.toString().trim() || undefined,
    address_line_1:
      formData.get("address_line_1")?.toString().trim() || undefined,
    city: formData.get("city")?.toString().trim() || undefined,
    state: formData.get("state")?.toString().trim() || undefined,
    postal_code: formData.get("postal_code")?.toString().trim() || undefined,
    source,
    status,
    project_type: validatedProjectType,
    description: formData.get("description")?.toString().trim() || undefined,
    insurance_claim: insuranceClaim,
    appointment_at: appointmentAt,
  };
}

export function formatSupabaseError(error: {
  message: string;
  details?: string | null;
  hint?: string | null;
}): string {
  return `${error.message}${error.details ? ` (${error.details})` : ""}${error.hint ? ` Hint: ${error.hint}` : ""}`;
}

export function computeLeadDashboardStats(leads: Lead[]): LeadDashboardStats {
  const dashboardLeads = leads.filter(isDashboardActiveLead);
  const activeLeads = dashboardLeads.filter(isActiveLead);
  const now = new Date();

  return {
    totalActiveLeads: activeLeads.length,
    newLeadsToday: dashboardLeads.filter((lead) => isNewLeadToday(lead, now))
      .length,
    highPriorityLeads: activeLeads.filter(
      (lead) => deriveLeadPriority(lead) === "high",
    ).length,
    leadsAwaitingContact: activeLeads.filter(isLeadAwaitingContact).length,
  };
}

export async function getLeadsForCompany(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Lead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getLeadByIdForCompany(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<Lead | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}
