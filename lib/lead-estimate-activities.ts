import { createActivity } from "@/lib/activity";
import { formatStatusChangeSummary } from "@/lib/lead-pipeline";
import {
  formatEstimateSentSummary,
  formatEstimateUpdatedSummary,
  type EstimateSendPlan,
} from "@/lib/lead-estimate";
import type { SupabaseClient } from "@supabase/supabase-js";

type LogEstimateSendActivitiesInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  previousStatus: string;
  plan: EstimateSendPlan;
  source: "pipeline" | "send_form";
  estimateSentAt: string | null;
  previousEstimateAmount?: number | null;
};

export async function logEstimateSendActivities(
  input: LogEstimateSendActivitiesInput,
): Promise<void> {
  const {
    supabase,
    companyId,
    leadId,
    actorUserId,
    previousStatus,
    plan,
    source,
    estimateSentAt,
    previousEstimateAmount = null,
  } = input;

  if (plan.statusChanged) {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "status_changed",
      summary: formatStatusChangeSummary(previousStatus, plan.nextStatus),
      actorUserId,
      metadata: {
        previous_status: previousStatus,
        updated_status: plan.nextStatus,
        source,
      },
    });
  }

  if (plan.estimateActivity === "sent" && estimateSentAt) {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "estimate_sent",
      summary: formatEstimateSentSummary(plan.estimateAmount, estimateSentAt),
      actorUserId,
      metadata: {
        estimate_amount: plan.estimateAmount,
        estimate_sent_at: estimateSentAt,
        source,
      },
    });
    return;
  }

  if (plan.estimateActivity === "updated") {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "estimate_created",
      summary: formatEstimateUpdatedSummary(plan.estimateAmount),
      actorUserId,
      metadata: {
        estimate_amount: plan.estimateAmount,
        previous_estimate_amount: previousEstimateAmount,
        source,
      },
    });
  }
}
