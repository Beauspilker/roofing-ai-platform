"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import {
  logFollowUpCompleteActivity,
  logFollowUpScheduleActivities,
} from "@/lib/lead-follow-up-activities";
import {
  parseFollowUpAtInput,
  planFollowUpComplete,
  planFollowUpScheduleFromDetail,
  shouldIncludeFollowUpAtInUpdate,
} from "@/lib/lead-follow-up";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function scheduleLeadFollowUp(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const followUpRaw = formData.get("follow_up_at")?.toString() ?? "";
  const followUpNotesRaw = formData.get("follow_up_notes")?.toString() ?? "";

  if (!leadId) {
    redirect("/dashboard");
  }

  const parsedFollowUp = parseFollowUpAtInput(followUpRaw);

  if ("error" in parsedFollowUp) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(parsedFollowUp.error)}`,
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

  const plan = planFollowUpScheduleFromDetail({
    lead,
    existingFollowUpAt: lead.follow_up_at,
    newFollowUpAt: parsedFollowUp.followUpAt,
    followUpNotesRaw,
  });

  if ("error" in plan) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(plan.error)}`,
    );
  }

  if (
    plan.followUpActivity === "none" ||
    !shouldIncludeFollowUpAtInUpdate(lead.follow_up_at, plan.followUpAt)
  ) {
    redirect(`/dashboard/leads/${leadId}?saved=1`);
  }

  const { error } = await supabase
    .from("leads")
    .update({ follow_up_at: plan.followUpAt })
    .eq("id", leadId)
    .eq("company_id", company.id);

  if (error) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(formatSupabaseError(error))}`,
    );
  }

  try {
    await logFollowUpScheduleActivities({
      supabase,
      companyId: company.id,
      leadId,
      actorUserId: user.id,
      plan,
      source: "follow_up_form",
      previousFollowUpAt: lead.follow_up_at,
    });
  } catch {
    // Lead is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}

export async function completeLeadFollowUp(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const followUpNotesRaw = formData.get("follow_up_notes")?.toString() ?? "";

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

  const completedAt = new Date().toISOString();
  const plan = planFollowUpComplete({
    lead,
    followUpNotesRaw,
    completedAt,
  });

  if ("error" in plan) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(plan.error)}`,
    );
  }

  const { error } = await supabase
    .from("leads")
    .update({ follow_up_at: null })
    .eq("id", leadId)
    .eq("company_id", company.id);

  if (error) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(formatSupabaseError(error))}`,
    );
  }

  try {
    await logFollowUpCompleteActivity({
      supabase,
      companyId: company.id,
      leadId,
      actorUserId: user.id,
      plan,
      source: "follow_up_form",
    });
  } catch {
    // Lead is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
