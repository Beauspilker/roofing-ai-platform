"use client";

import { sendLeadEstimate } from "@/app/dashboard/leads/[id]/estimate/actions";
import {
  canSendEstimateFromDetail,
  normalizeEstimateAmount,
} from "@/lib/lead-estimate";
import {
  formatLeadEstimateAmount,
  formatLeadEstimateSentAt,
  isArchivedLead,
  type Lead,
} from "@/lib/leads";

type LeadEstimateSectionProps = {
  lead: Lead;
};

export function LeadEstimateSection({ lead }: LeadEstimateSectionProps) {
  if (isArchivedLead(lead) || !canSendEstimateFromDetail(lead.status)) {
    return null;
  }

  const isUpdate = lead.status === "estimate_sent";
  const heading = isUpdate ? "Update estimate" : "Send estimate";
  const submitLabel = isUpdate ? "Update estimate amount" : "Send estimate";
  const normalizedAmount = normalizeEstimateAmount(lead.estimate_amount);
  const defaultEstimateValue =
    normalizedAmount !== null ? normalizedAmount.toString() : "";

  return (
    <section className="mb-8 space-y-4 border-b border-gray-800 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-white">{heading}</h2>
        <p className="mt-1 text-sm text-gray-400">
          {isUpdate
            ? "Update the estimate amount. Pipeline stage stays Estimate sent and the original sent date is preserved."
            : "Enter the estimate amount to move this lead to Estimate sent."}
        </p>
      </div>

      {normalizedAmount !== null ? (
        <p className="rounded-xl border border-cyan-900/50 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-100">
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

      <form action={sendLeadEstimate} className="space-y-4">
        <input type="hidden" name="lead_id" value={lead.id} />

        <div>
          <label
            htmlFor="estimate_amount"
            className="block text-sm font-medium text-gray-300"
          >
            Estimate amount
          </label>
          <input
            id="estimate_amount"
            name="estimate_amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            defaultValue={defaultEstimateValue}
            className="mt-2 w-full max-w-md rounded-xl border border-gray-700 bg-black/40 px-4 py-3 text-white focus:border-blue-500 focus:outline-none"
          />
        </div>

        {!isUpdate ? (
          <p className="text-xs text-gray-500">
            Saving will record the estimate and advance this lead to Estimate
            sent.
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
