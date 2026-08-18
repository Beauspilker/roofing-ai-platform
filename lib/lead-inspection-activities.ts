import { createActivity } from "@/lib/activity";
import { formatStatusChangeSummary } from "@/lib/lead-pipeline";
import {
  formatInspectionBookedSummary,
  formatInspectionUpdatedSummary,
  type InspectionSchedulingPlan,
} from "@/lib/lead-inspection";
import type { SupabaseClient } from "@supabase/supabase-js";

type LogInspectionSchedulingActivitiesInput = {
  supabase: SupabaseClient;
  companyId: string;
  leadId: string;
  actorUserId: string;
  previousStatus: string;
  plan: InspectionSchedulingPlan;
  source: "pipeline" | "schedule_form";
  previousAppointmentAt?: string | null;
};

export async function logInspectionSchedulingActivities(
  input: LogInspectionSchedulingActivitiesInput,
): Promise<void> {
  const {
    supabase,
    companyId,
    leadId,
    actorUserId,
    previousStatus,
    plan,
    source,
    previousAppointmentAt = null,
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

  if (plan.appointmentActivity === "booked") {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "appointment_booked",
      summary: formatInspectionBookedSummary(plan.appointmentAt),
      actorUserId,
      metadata: {
        appointment_at: plan.appointmentAt,
        source,
      },
    });
    return;
  }

  if (plan.appointmentActivity === "updated") {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "appointment_updated",
      summary: formatInspectionUpdatedSummary(plan.appointmentAt),
      actorUserId,
      metadata: {
        appointment_at: plan.appointmentAt,
        previous_appointment_at: previousAppointmentAt,
        source,
      },
    });
  }
}
