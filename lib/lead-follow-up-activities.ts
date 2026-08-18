import { createActivity } from "@/lib/activity";
import {
  formatFollowUpCompletedSummary,
  formatFollowUpRescheduledSummary,
  formatFollowUpScheduledSummary,
  type FollowUpCompletePlan,
  type FollowUpSchedulePlan,
} from "@/lib/lead-follow-up";
import type { SupabaseClient } from "@supabase/supabase-js";

type LogFollowUpScheduleActivitiesInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  plan: FollowUpSchedulePlan;
  source: "follow_up_form";
  previousFollowUpAt?: string | null;
};

type LogFollowUpCompleteActivityInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  plan: FollowUpCompletePlan;
  source: "follow_up_form";
};

export async function logFollowUpScheduleActivities(
  input: LogFollowUpScheduleActivitiesInput,
): Promise<void> {
  const {
    supabase,
    companyId,
    leadId,
    actorUserId,
    plan,
    source,
    previousFollowUpAt = null,
  } = input;

  if (plan.followUpActivity === "scheduled") {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "follow_up_scheduled",
      summary: formatFollowUpScheduledSummary(plan.followUpAt),
      actorUserId,
      metadata: {
        follow_up_at: plan.followUpAt,
        source,
        ...(plan.followUpNotes ? { follow_up_notes: plan.followUpNotes } : {}),
      },
    });
    return;
  }

  if (plan.followUpActivity === "rescheduled") {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "follow_up_rescheduled",
      summary: formatFollowUpRescheduledSummary(plan.followUpAt),
      actorUserId,
      metadata: {
        follow_up_at: plan.followUpAt,
        previous_follow_up_at: previousFollowUpAt,
        source,
        ...(plan.followUpNotes ? { follow_up_notes: plan.followUpNotes } : {}),
      },
    });
  }
}

export async function logFollowUpCompleteActivity(
  input: LogFollowUpCompleteActivityInput,
): Promise<void> {
  const { supabase, companyId, leadId, actorUserId, plan, source } = input;

  await createActivity(supabase, {
    companyId,
    leadId,
    activityType: "follow_up_completed",
    summary: formatFollowUpCompletedSummary(plan.previousFollowUpAt),
    actorUserId,
    metadata: {
      follow_up_at: plan.previousFollowUpAt,
      completed_at: plan.completedAt,
      source,
      ...(plan.followUpNotes ? { follow_up_notes: plan.followUpNotes } : {}),
    },
  });
}
