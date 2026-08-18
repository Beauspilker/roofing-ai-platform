"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import { logEstimateSendActivities } from "@/lib/lead-estimate-activities";
import {
  parseEstimateAmountInput,
  planEstimateSendFromDetail,
  resolveEstimateSentAtUpdate,
  shouldIncludeEstimateAmountInUpdate,
} from "@/lib/lead-estimate";
import { isAllowedPipelineStatusTransition } from "@/lib/lead-pipeline";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
  isLeadStatus,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function sendLeadEstimate(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const estimateAmountRaw = formData.get("estimate_amount")?.toString() ?? "";

  if (!leadId) {
    redirect("/dashboard");
  }

  const parsedEstimate = parseEstimateAmountInput(estimateAmountRaw);

  if ("error" in parsedEstimate) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(parsedEstimate.error)}`,
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

  if (!isLeadStatus(lead.status)) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("This lead cannot receive an estimate.")}`,
    );
  }

  const plan = planEstimateSendFromDetail({
    currentStatus: lead.status,
    existingEstimateAmount: lead.estimate_amount,
    existingEstimateSentAt: lead.estimate_sent_at,
    newEstimateAmount: parsedEstimate.estimateAmount,
  });

  if ("error" in plan) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(plan.error)}`,
    );
  }

  if (
    plan.statusChanged &&
    !isAllowedPipelineStatusTransition(lead.status, plan.nextStatus)
  ) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("That pipeline transition is not allowed.")}`,
    );
  }

  const estimateSentAt = resolveEstimateSentAtUpdate(
    lead.estimate_sent_at,
    plan.statusChanged,
  );

  const updatePayload: {
    estimate_amount?: number;
    estimate_sent_at?: string;
    status?: typeof plan.nextStatus;
  } = {};

  if (
    shouldIncludeEstimateAmountInUpdate(
      lead.estimate_amount,
      plan.estimateAmount,
    )
  ) {
    updatePayload.estimate_amount = plan.estimateAmount;
  }

  if (estimateSentAt !== undefined) {
    updatePayload.estimate_sent_at = estimateSentAt;
  }

  if (plan.statusChanged) {
    updatePayload.status = plan.nextStatus;
  }

  if (Object.keys(updatePayload).length === 0) {
    redirect(`/dashboard/leads/${leadId}?saved=1`);
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
    await logEstimateSendActivities({
      supabase,
      companyId: company.id,
      leadId,
      actorUserId: user.id,
      previousStatus: lead.status,
      plan,
      source: "send_form",
      estimateSentAt: estimateSentAt ?? lead.estimate_sent_at,
      previousEstimateAmount: lead.estimate_amount,
    });
  } catch {
    // Lead is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
