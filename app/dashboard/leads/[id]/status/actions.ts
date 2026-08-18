"use server";

import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import { logEstimateSendActivities } from "@/lib/lead-estimate-activities";
import {
  planPipelineEstimateAdvance,
  requiresEstimateForPipelineStatus,
  resolveEstimateSentAtUpdate,
  shouldIncludeEstimateAmountInUpdate,
} from "@/lib/lead-estimate";
import { logInspectionSchedulingActivities } from "@/lib/lead-inspection-activities";
import {
  planPipelineInspectionAdvance,
  requiresInspectionDateForPipelineStatus,
  shouldIncludeAppointmentAtInUpdate,
} from "@/lib/lead-inspection";
import {
  formatStatusChangeSummary,
  isAllowedPipelineStatusTransition,
} from "@/lib/lead-pipeline";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
  isLeadStatus,
  resolveLastContactedAtUpdate,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function updateLeadPipelineStatus(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const nextStatus = formData.get("status")?.toString() ?? "";

  if (!leadId) {
    redirect("/dashboard");
  }

  if (!isLeadStatus(nextStatus)) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("Invalid pipeline status.")}`,
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${leadId}`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, leadId, company.id);

  if (!lead || isArchivedLead(lead)) {
    redirect("/dashboard");
  }

  if (!isAllowedPipelineStatusTransition(lead.status, nextStatus)) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("That pipeline transition is not allowed.")}`,
    );
  }

  const lastContactedAt = resolveLastContactedAtUpdate(
    lead.status,
    nextStatus,
    lead.last_contacted_at,
  );

  let inspectionPlan = null;
  let estimatePlan = null;

  if (requiresInspectionDateForPipelineStatus(nextStatus)) {
    const formAppointmentRaw = formData.get("appointment_at")?.toString() ?? "";
    const planned = planPipelineInspectionAdvance({
      existingAppointmentAt: lead.appointment_at,
      formAppointmentAtRaw: formAppointmentRaw,
    });

    if ("error" in planned) {
      redirect(
        `/dashboard/leads/${leadId}?error=${encodeURIComponent(planned.error)}`,
      );
    }

    inspectionPlan = planned;
  }

  if (requiresEstimateForPipelineStatus(nextStatus)) {
    const formEstimateRaw = formData.get("estimate_amount")?.toString() ?? "";
    const planned = planPipelineEstimateAdvance({
      existingEstimateAmount: lead.estimate_amount,
      existingEstimateSentAt: lead.estimate_sent_at,
      formEstimateAmountRaw: formEstimateRaw,
    });

    if ("error" in planned) {
      redirect(
        `/dashboard/leads/${leadId}?error=${encodeURIComponent(planned.error)}`,
      );
    }

    estimatePlan = planned;
  }

  const estimateSentAt = estimatePlan
    ? resolveEstimateSentAtUpdate(lead.estimate_sent_at, estimatePlan.statusChanged)
    : undefined;

  const updatePayload: {
    status: typeof nextStatus;
    last_contacted_at?: string;
    appointment_at?: string;
    estimate_amount?: number;
    estimate_sent_at?: string;
  } = { status: nextStatus };

  if (lastContactedAt !== undefined) {
    updatePayload.last_contacted_at = lastContactedAt;
  }

  if (
    inspectionPlan &&
    shouldIncludeAppointmentAtInUpdate(
      lead.appointment_at,
      inspectionPlan.appointmentAt,
    )
  ) {
    updatePayload.appointment_at = inspectionPlan.appointmentAt;
  }

  if (
    estimatePlan &&
    shouldIncludeEstimateAmountInUpdate(
      lead.estimate_amount,
      estimatePlan.estimateAmount,
    )
  ) {
    updatePayload.estimate_amount = estimatePlan.estimateAmount;
  }

  if (estimateSentAt !== undefined) {
    updatePayload.estimate_sent_at = estimateSentAt;
  }

  const { error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", leadId)
    .eq("company_id", company.id);

  if (error) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(formatSupabaseError(error))}`,
    );
  }

  try {
    if (inspectionPlan) {
      await logInspectionSchedulingActivities({
        supabase,
        companyId: company.id,
        leadId,
        actorUserId: user.id,
        previousStatus: lead.status,
        plan: inspectionPlan,
        source: "pipeline",
        previousAppointmentAt: lead.appointment_at,
      });
    } else if (estimatePlan) {
      await logEstimateSendActivities({
        supabase,
        companyId: company.id,
        leadId,
        actorUserId: user.id,
        previousStatus: lead.status,
        plan: estimatePlan,
        source: "pipeline",
        estimateSentAt: estimateSentAt ?? lead.estimate_sent_at,
        previousEstimateAmount: lead.estimate_amount,
      });
    } else {
      await createActivity(supabase, {
        companyId: company.id,
        leadId,
        activityType: "status_changed",
        summary: formatStatusChangeSummary(lead.status, nextStatus),
        actorUserId: user.id,
        metadata: {
          previous_status: lead.status,
          updated_status: nextStatus,
          source: "pipeline",
          ...(lastContactedAt !== undefined
            ? { contact_recorded: true, last_contacted_at: lastContactedAt }
            : {}),
        },
      });
    }
  } catch {
    // Lead status is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
