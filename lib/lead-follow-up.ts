import { formatLeadAppointmentAt, isActiveLead, isArchivedLead, type Lead } from "@/lib/leads";
import { parseAppointmentAtInput } from "@/lib/lead-inspection";

export type FollowUpActivityKind = "scheduled" | "rescheduled" | "none";

export type FollowUpSchedulePlan = {
  followUpAt: string;
  followUpActivity: FollowUpActivityKind;
  followUpNotes: string | null;
};

export type FollowUpCompletePlan = {
  followUpActivity: "completed";
  previousFollowUpAt: string;
  completedAt: string;
  followUpNotes: string | null;
};

export function canScheduleFollowUpFromDetail(
  lead: Pick<Lead, "status" | "archived_at">,
): boolean {
  if (isArchivedLead(lead as Lead)) {
    return false;
  }

  return isActiveLead(lead as Lead);
}

export function canCompleteFollowUpFromDetail(
  lead: Pick<Lead, "status" | "archived_at" | "follow_up_at">,
): boolean {
  return canScheduleFollowUpFromDetail(lead) && lead.follow_up_at !== null;
}

export function hasOpenFollowUp(followUpAt: string | null): boolean {
  return followUpAt !== null;
}

export function isFollowUpOverdue(
  followUpAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!followUpAt) {
    return false;
  }

  return new Date(followUpAt).getTime() < now.getTime();
}

export function normalizeFollowUpNotes(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveFollowUpActivityKind(
  existingFollowUpAt: string | null,
  newFollowUpAt: string,
): FollowUpActivityKind {
  if (!existingFollowUpAt) {
    return "scheduled";
  }

  if (existingFollowUpAt !== newFollowUpAt) {
    return "rescheduled";
  }

  return "none";
}

export function shouldIncludeFollowUpAtInUpdate(
  existingFollowUpAt: string | null,
  nextFollowUpAt: string,
): boolean {
  return existingFollowUpAt !== nextFollowUpAt;
}

export function planFollowUpScheduleFromDetail(input: {
  lead: Pick<Lead, "status" | "archived_at">;
  existingFollowUpAt: string | null;
  newFollowUpAt: string;
  followUpNotesRaw: string;
}): FollowUpSchedulePlan | { error: string } {
  if (!canScheduleFollowUpFromDetail(input.lead)) {
    return {
      error: "Follow-ups cannot be scheduled for closed or archived leads.",
    };
  }

  const followUpActivity = resolveFollowUpActivityKind(
    input.existingFollowUpAt,
    input.newFollowUpAt,
  );

  return {
    followUpAt: input.newFollowUpAt,
    followUpActivity,
    followUpNotes: normalizeFollowUpNotes(input.followUpNotesRaw),
  };
}

export function planFollowUpComplete(input: {
  lead: Pick<Lead, "status" | "archived_at" | "follow_up_at">;
  followUpNotesRaw: string;
  completedAt: string;
}): FollowUpCompletePlan | { error: string } {
  if (!canCompleteFollowUpFromDetail(input.lead)) {
    return {
      error: "This lead does not have an open follow-up to complete.",
    };
  }

  return {
    followUpActivity: "completed",
    previousFollowUpAt: input.lead.follow_up_at as string,
    completedAt: input.completedAt,
    followUpNotes: normalizeFollowUpNotes(input.followUpNotesRaw),
  };
}

export function parseFollowUpAtInput(
  raw: string,
): { followUpAt: string } | { error: string } {
  const parsed = parseAppointmentAtInput(raw);

  if ("error" in parsed) {
    return {
      error: parsed.error.replace(
        "inspection date and time",
        "follow-up date and time",
      ),
    };
  }

  return { followUpAt: parsed.appointmentAt };
}

export function formatFollowUpScheduledSummary(followUpAt: string): string {
  return `Follow-up scheduled for ${formatLeadAppointmentAt(followUpAt)}`;
}

export function formatFollowUpRescheduledSummary(followUpAt: string): string {
  return `Follow-up rescheduled to ${formatLeadAppointmentAt(followUpAt)}`;
}

export function formatFollowUpCompletedSummary(followUpAt: string): string {
  return `Follow-up completed for ${formatLeadAppointmentAt(followUpAt)}`;
}
