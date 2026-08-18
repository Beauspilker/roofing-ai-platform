import { formatLeadAppointmentAt, type LeadStatus } from "@/lib/leads";

export type InspectionActivityKind = "booked" | "updated" | "none";

export type InspectionSchedulingPlan = {
  appointmentAt: string;
  nextStatus: LeadStatus;
  statusChanged: boolean;
  appointmentActivity: InspectionActivityKind;
};

export function requiresInspectionDateForPipelineStatus(
  nextStatus: LeadStatus,
): boolean {
  return nextStatus === "appointment_scheduled";
}

export function canScheduleInspectionFromDetail(status: string): boolean {
  return status === "contacted" || status === "appointment_scheduled";
}

export function parseAppointmentAtInput(
  raw: string,
): { appointmentAt: string } | { error: string } {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { error: "Please enter an inspection date and time." };
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return { error: "Please enter a valid inspection date and time." };
  }

  return { appointmentAt: parsed.toISOString() };
}

export function resolveAppointmentAtForPipelineAdvance(
  existingAppointmentAt: string | null,
  formAppointmentAtRaw: string,
): { appointmentAt: string } | { error: string } {
  if (existingAppointmentAt) {
    const trimmed = formAppointmentAtRaw.trim();

    if (trimmed) {
      return parseAppointmentAtInput(trimmed);
    }

    return { appointmentAt: existingAppointmentAt };
  }

  return parseAppointmentAtInput(formAppointmentAtRaw);
}

export function resolveInspectionAppointmentActivity(
  existingAppointmentAt: string | null,
  newAppointmentAt: string,
): InspectionActivityKind {
  if (!existingAppointmentAt) {
    return "booked";
  }

  if (existingAppointmentAt !== newAppointmentAt) {
    return "updated";
  }

  return "none";
}

export function planInspectionScheduleFromDetail(input: {
  currentStatus: LeadStatus;
  existingAppointmentAt: string | null;
  newAppointmentAt: string;
}): InspectionSchedulingPlan | { error: string } {
  const appointmentActivity = resolveInspectionAppointmentActivity(
    input.existingAppointmentAt,
    input.newAppointmentAt,
  );

  if (input.currentStatus === "contacted") {
    return {
      appointmentAt: input.newAppointmentAt,
      nextStatus: "appointment_scheduled",
      statusChanged: true,
      appointmentActivity,
    };
  }

  if (input.currentStatus === "appointment_scheduled") {
    if (appointmentActivity === "none") {
      return {
        appointmentAt: input.newAppointmentAt,
        nextStatus: "appointment_scheduled",
        statusChanged: false,
        appointmentActivity,
      };
    }

    return {
      appointmentAt: input.newAppointmentAt,
      nextStatus: "appointment_scheduled",
      statusChanged: false,
      appointmentActivity,
    };
  }

  return {
    error:
      "Inspection can only be scheduled for contacted leads or rescheduled for leads already in the Inspection scheduled stage.",
  };
}

export function planPipelineInspectionAdvance(input: {
  existingAppointmentAt: string | null;
  formAppointmentAtRaw: string;
}): InspectionSchedulingPlan | { error: string } {
  const resolved = resolveAppointmentAtForPipelineAdvance(
    input.existingAppointmentAt,
    input.formAppointmentAtRaw,
  );

  if ("error" in resolved) {
    return resolved;
  }

  return {
    appointmentAt: resolved.appointmentAt,
    nextStatus: "appointment_scheduled",
    statusChanged: true,
    appointmentActivity: resolveInspectionAppointmentActivity(
      input.existingAppointmentAt,
      resolved.appointmentAt,
    ),
  };
}

export function formatInspectionBookedSummary(appointmentAt: string): string {
  return `Inspection scheduled for ${formatLeadAppointmentAt(appointmentAt)}`;
}

export function formatInspectionUpdatedSummary(appointmentAt: string): string {
  return `Inspection rescheduled to ${formatLeadAppointmentAt(appointmentAt)}`;
}

export function shouldIncludeAppointmentAtInUpdate(
  existingAppointmentAt: string | null,
  nextAppointmentAt: string,
): boolean {
  return existingAppointmentAt !== nextAppointmentAt;
}
