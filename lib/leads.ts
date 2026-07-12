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

export function isActiveLead(lead: Lead): boolean {
  return !INACTIVE_STATUSES.has(lead.status);
}

export function deriveLeadPriority(lead: Lead): LeadPriority {
  if (
    lead.insurance_claim ||
    (lead.status === "new" && lead.last_contacted_at === null)
  ) {
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

export function computeLeadDashboardStats(leads: Lead[]): LeadDashboardStats {
  const activeLeads = leads.filter(isActiveLead);
  const now = new Date();

  return {
    totalActiveLeads: activeLeads.length,
    newLeadsToday: leads.filter((lead) => isNewLeadToday(lead, now)).length,
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
