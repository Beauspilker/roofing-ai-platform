"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import { logInspectionSchedulingActivities } from "@/lib/lead-inspection-activities";
import {
  parseAppointmentAtInput,
  planInspectionScheduleFromDetail,
  shouldIncludeAppointmentAtInUpdate,
} from "@/lib/lead-inspection";
import { isAllowedPipelineStatusTransition } from "@/lib/lead-pipeline";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
  isLeadStatus,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export async function scheduleLeadInspection(formData: FormData) {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const appointmentRaw = formData.get("appointment_at")?.toString() ?? "";

  if (!leadId) {
    redirect("/dashboard");
  }

  const parsedAppointment = parseAppointmentAtInput(appointmentRaw);

  if ("error" in parsedAppointment) {
    redirect(
      `/dashboard/leads/${leadId}?error=${encodeURIComponent(parsedAppointment.error)}`,
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
      `/dashboard/leads/${leadId}?error=${encodeURIComponent("This lead cannot be scheduled for inspection.")}`,
    );
  }

  const plan = planInspectionScheduleFromDetail({
    currentStatus: lead.status,
    existingAppointmentAt: lead.appointment_at,
    newAppointmentAt: parsedAppointment.appointmentAt,
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

  const updatePayload: {
    appointment_at?: string;
    status?: typeof plan.nextStatus;
  } = {};

  if (shouldIncludeAppointmentAtInUpdate(lead.appointment_at, plan.appointmentAt)) {
    updatePayload.appointment_at = plan.appointmentAt;
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
    await logInspectionSchedulingActivities({
      supabase,
      companyId: company.id,
      leadId,
      actorUserId: user.id,
      previousStatus: lead.status,
      plan,
      source: "schedule_form",
      previousAppointmentAt: lead.appointment_at,
    });
  } catch {
    // Lead is updated even if activity logging fails.
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
