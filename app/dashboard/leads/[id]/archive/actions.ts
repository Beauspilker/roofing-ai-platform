"use server";

import { redirect } from "next/navigation";
import { createActivity, getArchivedPreviousStatus } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
  isLeadStatus,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function archiveLead(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";

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

  const { error } = await supabase
    .from("leads")
    .update({
      archived_at: new Date().toISOString(),
      status: "archived",
    })
    .eq("id", leadId)
    .eq("company_id", company.id);

  if (error) {
    redirect(`/dashboard/leads/${leadId}?error=${encodeURIComponent(formatSupabaseError(error))}`);
  }

  try {
    await createActivity(supabase, {
      companyId: company.id,
      leadId,
      activityType: "status_changed",
      summary: "Lead archived",
      actorUserId: user.id,
      metadata: {
        previous_status: lead.status,
        event: "lead_archived",
      },
    });
  } catch {
    // Lead is archived even if activity logging fails.
  }

  redirect("/dashboard");
}

export async function restoreLead(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";

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
  if (!lead || !isArchivedLead(lead)) {
    redirect(`/dashboard/leads/${leadId}`);
  }

  const previousStatus =
    (await getArchivedPreviousStatus(supabase, leadId, company.id)) ?? "new";
  const restoredStatus = isLeadStatus(previousStatus) ? previousStatus : "new";

  const { error } = await supabase
    .from("leads")
    .update({
      archived_at: null,
      status: restoredStatus,
    })
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
      summary: "Lead restored",
      actorUserId: user.id,
      metadata: {
        restored_status: restoredStatus,
        event: "lead_restored",
      },
    });
  } catch {
    // Lead is restored even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?restored=1`);
}
