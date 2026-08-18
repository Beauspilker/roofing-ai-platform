import type { ActivityHistory } from "@/lib/activity";
import { canMarkLeadAsLost } from "@/lib/lead-pipeline";
import {
  formatLeadAppointmentAt,
  formatLeadEstimateAmount,
} from "@/lib/leads";
import { normalizeEstimateAmount, parseEstimateAmountInput } from "@/lib/lead-estimate";

export type LeadOutcomeDisplay = {
  type: "won" | "lost";
  recordedAt: string;
  finalJobAmount: number | null;
  lostReason: string | null;
  lostNotes: string | null;
};

export type WonOutcomePlan = {
  nextStatus: "won";
  statusChanged: true;
  finalJobAmount: number;
  estimateAmountChanged: boolean;
};

export type LostOutcomePlan = {
  nextStatus: "lost";
  statusChanged: true;
  lostReason: string | null;
  lostNotes: string | null;
};

export function canMarkLeadWonFromDetail(status: string): boolean {
  return status === "estimate_sent";
}

export function canShowLostOutcomeFields(status: string): boolean {
  return canMarkLeadAsLost(status);
}

export function resolveFinalJobAmountForWon(
  existingEstimateAmount: number | null,
  formFinalJobAmountRaw: string,
): { finalJobAmount: number } | { error: string } {
  const normalizedExisting = normalizeEstimateAmount(existingEstimateAmount);
  const trimmed = formFinalJobAmountRaw.trim();

  if (trimmed) {
    const parsed = parseEstimateAmountInput(trimmed);

    if ("error" in parsed) {
      return parsed;
    }

    return { finalJobAmount: parsed.estimateAmount };
  }

  if (normalizedExisting !== null) {
    return { finalJobAmount: normalizedExisting };
  }

  return {
    error:
      "An estimate amount is required before this lead can be marked as won.",
  };
}

export function planMarkLeadWon(input: {
  currentStatus: string;
  existingEstimateAmount: number | null;
  formFinalJobAmountRaw: string;
}): WonOutcomePlan | { error: string } {
  if (input.currentStatus !== "estimate_sent") {
    return {
      error:
        "Only leads in the Estimate sent stage can be marked as won from here.",
    };
  }

  const resolved = resolveFinalJobAmountForWon(
    input.existingEstimateAmount,
    input.formFinalJobAmountRaw,
  );

  if ("error" in resolved) {
    return resolved;
  }

  const normalizedExisting = normalizeEstimateAmount(input.existingEstimateAmount);

  return {
    nextStatus: "won",
    statusChanged: true,
    finalJobAmount: resolved.finalJobAmount,
    estimateAmountChanged:
      normalizedExisting !== resolved.finalJobAmount,
  };
}

export function planPipelineWonAdvance(input: {
  existingEstimateAmount: number | null;
  formFinalJobAmountRaw: string;
}): WonOutcomePlan | { error: string } {
  const resolved = resolveFinalJobAmountForWon(
    input.existingEstimateAmount,
    input.formFinalJobAmountRaw,
  );

  if ("error" in resolved) {
    return resolved;
  }

  const normalizedExisting = normalizeEstimateAmount(input.existingEstimateAmount);

  return {
    nextStatus: "won",
    statusChanged: true,
    finalJobAmount: resolved.finalJobAmount,
    estimateAmountChanged:
      normalizedExisting !== resolved.finalJobAmount,
  };
}

const LOST_REASON_OPTIONS = [
  { value: "", label: "Select a reason (optional)" },
  { value: "price", label: "Price too high" },
  { value: "competitor", label: "Chose another contractor" },
  { value: "timing", label: "Bad timing / not ready" },
  { value: "insurance", label: "Insurance issue" },
  { value: "no_response", label: "No response" },
  { value: "other", label: "Other" },
] as const;

export const LOST_REASON_FORM_OPTIONS = LOST_REASON_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));

export function formatLostReasonLabel(reason: string | null): string | null {
  if (!reason) {
    return null;
  }

  const match = LOST_REASON_OPTIONS.find((option) => option.value === reason);
  return match && match.value ? match.label : reason;
}

export function planMarkLeadLost(input: {
  currentStatus: string;
  lostReasonRaw: string;
  lostNotesRaw: string;
}): LostOutcomePlan | { error: string } {
  if (!canMarkLeadAsLost(input.currentStatus)) {
    return {
      error: "This lead cannot be marked as lost from its current stage.",
    };
  }

  const lostReason = input.lostReasonRaw.trim() || null;
  const lostNotes = input.lostNotesRaw.trim() || null;

  if (lostReason && !LOST_REASON_OPTIONS.some((option) => option.value === lostReason)) {
    return { error: "Please select a valid lost reason." };
  }

  return {
    nextStatus: "lost",
    statusChanged: true,
    lostReason,
    lostNotes,
  };
}

export function shouldIncludeFinalJobAmountInUpdate(
  existingEstimateAmount: number | null,
  finalJobAmount: number,
): boolean {
  return normalizeEstimateAmount(existingEstimateAmount) !== finalJobAmount;
}

export function formatLeadWonSummary(
  finalJobAmount: number,
  wonAt: string,
): string {
  return `Lead won: ${formatLeadEstimateAmount(finalJobAmount)} on ${formatLeadAppointmentAt(wonAt)}`;
}

export function formatLeadLostSummary(
  lostReason: string | null,
  lostNotes: string | null,
): string {
  const reasonLabel = formatLostReasonLabel(lostReason);
  const parts = ["Lead marked lost"];

  if (reasonLabel) {
    parts.push(reasonLabel);
  }

  if (lostNotes) {
    parts.push(lostNotes);
  }

  return parts.join(": ");
}

export function getLeadOutcomeFromActivities(
  activities: ActivityHistory[],
): LeadOutcomeDisplay | null {
  for (const activity of activities) {
    if (activity.activity_type !== "status_changed") {
      continue;
    }

    const metadata = activity.metadata;
    const outcome = metadata.outcome;

    if (outcome === "won") {
      const wonAt =
        typeof metadata.won_at === "string" ? metadata.won_at : activity.created_at;
      const finalJobAmount =
        typeof metadata.final_job_amount === "number"
          ? metadata.final_job_amount
          : null;

      return {
        type: "won",
        recordedAt: wonAt,
        finalJobAmount,
        lostReason: null,
        lostNotes: null,
      };
    }

    if (outcome === "lost") {
      const lostAt =
        typeof metadata.lost_at === "string" ? metadata.lost_at : activity.created_at;

      return {
        type: "lost",
        recordedAt: lostAt,
        finalJobAmount: null,
        lostReason:
          typeof metadata.lost_reason === "string" ? metadata.lost_reason : null,
        lostNotes:
          typeof metadata.lost_notes === "string" ? metadata.lost_notes : null,
      };
    }
  }

  return null;
}
