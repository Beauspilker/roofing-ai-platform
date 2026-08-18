"use client";

import {
  completeLeadFollowUp,
  scheduleLeadFollowUp,
} from "@/app/dashboard/leads/[id]/follow-up/actions";
import {
  canCompleteFollowUpFromDetail,
  canScheduleFollowUpFromDetail,
  isFollowUpOverdue,
} from "@/lib/lead-follow-up";
import {
  formatDateTimeLocalValue,
  formatLeadFollowUpAt,
  isArchivedLead,
  type Lead,
} from "@/lib/leads";

type LeadFollowUpSectionProps = {
  lead: Lead;
};

export function LeadFollowUpSection({ lead }: LeadFollowUpSectionProps) {
  if (isArchivedLead(lead) || !canScheduleFollowUpFromDetail(lead)) {
    return null;
  }

  const hasFollowUp = lead.follow_up_at !== null;
  const overdue = isFollowUpOverdue(lead.follow_up_at);
  const heading = hasFollowUp ? "Reschedule follow-up" : "Schedule follow-up";
  const submitLabel = hasFollowUp ? "Update follow-up" : "Schedule follow-up";
  const defaultFollowUpValue = formatDateTimeLocalValue(lead.follow_up_at);

  return (
    <section className="mb-8 space-y-4 border-b border-gray-800 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Follow-up</h2>
        <p className="mt-1 text-sm text-gray-400">
          {hasFollowUp
            ? "Update the contractor follow-up date and time, or mark it complete when done."
            : "Set a contractor follow-up reminder for this lead. This does not change pipeline status."}
        </p>
      </div>

      {hasFollowUp ? (
        <p
          className={`rounded-xl border px-4 py-3 text-sm ${
            overdue
              ? "border-red-900/50 bg-red-950/30 text-red-100"
              : "border-amber-900/50 bg-amber-950/30 text-amber-100"
          }`}
        >
          {overdue ? "Overdue: " : "Scheduled for "}
          <span className="font-medium">
            {formatLeadFollowUpAt(lead.follow_up_at as string)}
          </span>
        </p>
      ) : null}

      <form action={scheduleLeadFollowUp} className="space-y-4">
        <input type="hidden" name="lead_id" value={lead.id} />

        <div>
          <label
            htmlFor="follow_up_at"
            className="block text-sm font-medium text-gray-300"
          >
            Follow-up date and time
          </label>
          <input
            id="follow_up_at"
            name="follow_up_at"
            type="datetime-local"
            required
            defaultValue={defaultFollowUpValue}
            className="mt-2 w-full max-w-md rounded-xl border border-gray-700 bg-black/40 px-4 py-3 text-white focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="follow_up_notes"
            className="block text-sm font-medium text-gray-300"
          >
            Follow-up notes
          </label>
          <textarea
            id="follow_up_notes"
            name="follow_up_notes"
            rows={3}
            placeholder="Optional notes about this follow-up"
            className="mt-2 w-full max-w-md rounded-xl border border-gray-700 bg-black/40 px-4 py-3 text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          className="inline-flex rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700"
        >
          {submitLabel}
        </button>
      </form>

      {canCompleteFollowUpFromDetail(lead) ? (
        <form action={completeLeadFollowUp} className="space-y-4">
          <input type="hidden" name="lead_id" value={lead.id} />

          <p className="text-xs text-gray-500">
            Marking complete clears the open follow-up and records it in activity
            history.
          </p>

          <button
            type="submit"
            className="inline-flex rounded-xl border border-gray-700 px-6 py-3 text-sm font-semibold text-gray-200 transition hover:border-gray-600 hover:text-white"
          >
            Mark follow-up complete
          </button>
        </form>
      ) : null}
    </section>
  );
}
