"use server";

import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
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

  const updatePayload: {
    status: typeof nextStatus;
    last_contacted_at?: string;
  } = { status: nextStatus };

  if (lastContactedAt !== undefined) {
    updatePayload.last_contacted_at = lastContactedAt;
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
  } catch {
    // Lead status is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
