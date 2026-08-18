import { createActivity } from "@/lib/activity";
import {
  formatLeadLostSummary,
  formatLeadWonSummary,
  formatLostReasonLabel,
  type LostOutcomePlan,
  type WonOutcomePlan,
} from "@/lib/lead-outcome";
import type { SupabaseClient } from "@supabase/supabase-js";

type LogWonOutcomeActivityInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  previousStatus: string;
  plan: WonOutcomePlan;
  wonAt: string;
  source: "pipeline" | "won_form";
  estimateSentAt: string | null;
};

type LogLostOutcomeActivityInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  previousStatus: string;
  plan: LostOutcomePlan;
  lostAt: string;
  source: "pipeline";
};

export async function logWonOutcomeActivity(
  input: LogWonOutcomeActivityInput,
): Promise<void> {
  const {
    supabase,
    companyId,
    leadId,
    actorUserId,
    previousStatus,
    plan,
    wonAt,
    source,
    estimateSentAt,
  } = input;

  await createActivity(supabase, {
    companyId,
    leadId,
    activityType: "status_changed",
    summary: formatLeadWonSummary(plan.finalJobAmount, wonAt),
    actorUserId,
    metadata: {
      outcome: "won",
      won_at: wonAt,
      final_job_amount: plan.finalJobAmount,
      previous_status: previousStatus,
      updated_status: plan.nextStatus,
      source,
      ...(estimateSentAt ? { estimate_sent_at: estimateSentAt } : {}),
    },
  });
}

export async function logLostOutcomeActivity(
  input: LogLostOutcomeActivityInput,
): Promise<void> {
  const {
    supabase,
    companyId,
    leadId,
    actorUserId,
    previousStatus,
    plan,
    lostAt,
    source,
  } = input;

  await createActivity(supabase, {
    companyId,
    leadId,
    activityType: "status_changed",
    summary: formatLeadLostSummary(plan.lostReason, plan.lostNotes),
    actorUserId,
    metadata: {
      outcome: "lost",
      lost_at: lostAt,
      previous_status: previousStatus,
      updated_status: plan.nextStatus,
      source,
      ...(plan.lostReason
        ? {
            lost_reason: plan.lostReason,
            lost_reason_label: formatLostReasonLabel(plan.lostReason),
          }
        : {}),
      ...(plan.lostNotes ? { lost_notes: plan.lostNotes } : {}),
    },
  });
}
