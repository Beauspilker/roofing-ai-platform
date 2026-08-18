"use client";

import { markLeadWon } from "@/app/dashboard/leads/[id]/outcome/actions";
import { canMarkLeadWonFromDetail } from "@/lib/lead-outcome";
import { normalizeEstimateAmount } from "@/lib/lead-estimate";
import {
  formatLeadEstimateAmount,
  formatLeadEstimateSentAt,
  isArchivedLead,
  type Lead,
} from "@/lib/leads";

type LeadWonSectionProps = {
  lead: Lead;
};

export function LeadWonSection({ lead }: LeadWonSectionProps) {
  if (isArchivedLead(lead) || !canMarkLeadWonFromDetail(lead.status)) {
    return null;
  }

  const normalizedAmount = normalizeEstimateAmount(lead.estimate_amount);
  const defaultFinalJobValue =
    normalizedAmount !== null ? normalizedAmount.toString() : "";

  return (
    <section className="mb-8 space-y-4 border-b border-gray-800 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Mark as won</h2>
        <p className="mt-1 text-sm text-gray-400">
          Close this lead as won. The estimate sent date is preserved. Adjust the
          final job value only if it differs from the estimate.
        </p>
      </div>

      {normalizedAmount !== null ? (
        <p className="rounded-xl border border-green-900/50 bg-green-950/30 px-4 py-3 text-sm text-green-100">
          Current estimate:{" "}
          <span className="font-medium">
            {formatLeadEstimateAmount(normalizedAmount)}
          </span>
          {lead.estimate_sent_at ? (
            <>
              {" "}
              · Sent {formatLeadEstimateSentAt(lead.estimate_sent_at)}
            </>
          ) : null}
        </p>
      ) : null}

      <form action={markLeadWon} className="space-y-4">
        <input type="hidden" name="lead_id" value={lead.id} />

        <div>
          <label
            htmlFor="final_job_amount"
            className="block text-sm font-medium text-gray-300"
          >
            Final job value
          </label>
          <input
            id="final_job_amount"
            name="final_job_amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            defaultValue={defaultFinalJobValue}
            className="mt-2 w-full max-w-md rounded-xl border border-gray-700 bg-black/40 px-4 py-3 text-white focus:border-blue-500 focus:outline-none"
          />
        </div>

        <p className="text-xs text-gray-500">
          Saving will mark this lead as Won and record the outcome in activity
          history.
        </p>

        <button
          type="submit"
          className="inline-flex rounded-xl bg-green-700 px-6 py-3 text-sm font-semibold transition hover:bg-green-600"
        >
          Mark as won
        </button>
      </form>
    </section>
  );
}
