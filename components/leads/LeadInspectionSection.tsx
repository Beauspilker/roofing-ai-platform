"use client";

import { scheduleLeadInspection } from "@/app/dashboard/leads/[id]/inspection/actions";
import {
  canScheduleInspectionFromDetail,
} from "@/lib/lead-inspection";
import {
  formatDateTimeLocalValue,
  formatLeadAppointmentAt,
  isArchivedLead,
  type Lead,
} from "@/lib/leads";

type LeadInspectionSectionProps = {
  lead: Lead;
};

export function LeadInspectionSection({ lead }: LeadInspectionSectionProps) {
  if (isArchivedLead(lead) || !canScheduleInspectionFromDetail(lead.status)) {
    return null;
  }

  const isReschedule = lead.status === "appointment_scheduled";
  const heading = isReschedule ? "Reschedule inspection" : "Schedule inspection";
  const submitLabel = isReschedule
    ? "Update inspection time"
    : "Schedule inspection";
  const defaultAppointmentValue = formatDateTimeLocalValue(lead.appointment_at);

  return (
    <section className="mb-8 space-y-4 border-b border-gray-800 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-white">{heading}</h2>
        <p className="mt-1 text-sm text-gray-400">
          {isReschedule
            ? "Update the scheduled inspection date and time. Pipeline stage stays Inspection scheduled."
            : "Choose an inspection date and time to move this lead to Inspection scheduled."}
        </p>
      </div>

      {lead.appointment_at ? (
        <p className="rounded-xl border border-purple-900/50 bg-purple-950/30 px-4 py-3 text-sm text-purple-100">
          Currently scheduled:{" "}
          <span className="font-medium">
            {formatLeadAppointmentAt(lead.appointment_at)}
          </span>
        </p>
      ) : null}

      <form action={scheduleLeadInspection} className="space-y-4">
        <input type="hidden" name="lead_id" value={lead.id} />

        <div>
          <label
            htmlFor="inspection_appointment_at"
            className="block text-sm font-medium text-gray-300"
          >
            Inspection date and time
          </label>
          <input
            id="inspection_appointment_at"
            name="appointment_at"
            type="datetime-local"
            required
            defaultValue={defaultAppointmentValue}
            className="mt-2 w-full max-w-md rounded-xl border border-gray-700 bg-black/40 px-4 py-3 text-white focus:border-blue-500 focus:outline-none"
          />
        </div>

        {!isReschedule ? (
          <p className="text-xs text-gray-500">
            Saving will record the inspection and advance this lead to
            Inspection scheduled.
          </p>
        ) : null}

        <button
          type="submit"
          className="inline-flex rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700"
        >
          {submitLabel}
        </button>
      </form>
    </section>
  );
}
