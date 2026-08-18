"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import { logWonOutcomeActivity } from "@/lib/lead-outcome-activities";
import { planMarkLeadWon, shouldIncludeFinalJobAmountInUpdate } from "@/lib/lead-outcome";
import { isAllowedPipelineStatusTransition } from "@/lib/lead-pipeline";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
  isLeadStatus,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function markLeadWon(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const finalJobAmountRaw = formData.get("final_job_amount")?.toString() ?? "";

  if (!leadId) {
    redirect("/dashboard");
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
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("This lead cannot be marked as won.")}`,
    );
  }

  const plan = planMarkLeadWon({
    currentStatus: lead.status,
    existingEstimateAmount: lead.estimate_amount,
    formFinalJobAmountRaw: finalJobAmountRaw,
  });

  if ("error" in plan) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(plan.error)}`,
    );
  }

  if (!isAllowedPipelineStatusTransition(lead.status, plan.nextStatus)) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("That pipeline transition is not allowed.")}`,
    );
  }

  const wonAt = new Date().toISOString();

  const updatePayload: {
    status: "won";
    estimate_amount?: number;
  } = {
    status: plan.nextStatus,
  };

  if (
    plan.estimateAmountChanged &&
    shouldIncludeFinalJobAmountInUpdate(lead.estimate_amount, plan.finalJobAmount)
  ) {
    updatePayload.estimate_amount = plan.finalJobAmount;
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
    await logWonOutcomeActivity({
      supabase,
      companyId: company.id,
      leadId,
      actorUserId: user.id,
      previousStatus: lead.status,
      plan,
      wonAt,
      source: "won_form",
      estimateSentAt: lead.estimate_sent_at,
    });
  } catch {
    // Lead is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
