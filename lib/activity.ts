import type { SupabaseClient } from "@supabase/supabase-js";

export const ACTIVITY_TYPES = [
  "lead_created",
  "call_received",
  "call_missed",
  "note_added",
  "photo_uploaded",
  "status_changed",
  "appointment_booked",
  "appointment_updated",
  "estimate_created",
  "estimate_sent",
  "settings_updated",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActivityHistory = {
  id: string;
  company_id: string;
  lead_id: string | null;
  activity_type: ActivityType;
  summary: string;
  metadata: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
};

export function isActivityType(value: string): value is ActivityType {
  return ACTIVITY_TYPES.includes(value as ActivityType);
}

export function formatActivityDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

export function formatActivityTime(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

export async function getActivityByLeadId(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<ActivityHistory[]> {
  const { data, error } = await supabase
    .from("activity_history")
    .select("*")
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((item) => ({
    ...item,
    metadata:
      item.metadata && typeof item.metadata === "object"
        ? (item.metadata as Record<string, unknown>)
        : {},
  }));
}

type CreateActivityInput = {
  companyId: string;
  leadId: string;
  activityType: ActivityType;
  summary: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function createActivity(
  supabase: SupabaseClient,
  {
    companyId,
    leadId,
    activityType,
    summary,
    actorUserId = null,
    metadata = {},
  }: CreateActivityInput,
): Promise<ActivityHistory> {
  const trimmedSummary = summary.trim();

  if (!trimmedSummary) {
    throw new Error("Activity summary cannot be empty.");
  }

  const { data, error } = await supabase
    .from("activity_history")
    .insert({
      company_id: companyId,
      lead_id: leadId,
      activity_type: activityType,
      summary: trimmedSummary,
      metadata,
      actor_user_id: actorUserId,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Failed to create activity record.");
  }

  return {
    ...data,
    metadata:
      data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, unknown>)
        : {},
  };
}

export async function getArchivedPreviousStatus(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("activity_history")
    .select("metadata")
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .eq("summary", "Lead archived")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (
    data?.metadata &&
    typeof data.metadata === "object" &&
    "previous_status" in data.metadata &&
    typeof data.metadata.previous_status === "string"
  ) {
    return data.metadata.previous_status;
  }

  return null;
}
