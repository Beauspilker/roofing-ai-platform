import {
  formatLeadAppointmentAt,
  formatLeadEstimateAmount,
  type LeadStatus,
} from "@/lib/leads";

export type EstimateActivityKind = "sent" | "updated" | "none";

export type EstimateSendPlan = {
  estimateAmount: number;
  nextStatus: LeadStatus;
  statusChanged: boolean;
  estimateActivity: EstimateActivityKind;
};

export function requiresEstimateForPipelineStatus(
  nextStatus: LeadStatus,
): boolean {
  return nextStatus === "estimate_sent";
}

export function canSendEstimateFromDetail(status: string): boolean {
  return status === "appointment_scheduled" || status === "estimate_sent";
}

export function normalizeEstimateAmount(
  value: number | string | null,
): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

export function parseEstimateAmountInput(
  raw: string,
): { estimateAmount: number } | { error: string } {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { error: "Please enter an estimate amount." };
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: "Please enter a valid estimate amount." };
  }

  if (parsed === 0) {
    return { error: "Please enter an estimate amount greater than zero." };
  }

  return { estimateAmount: normalizeEstimateAmount(parsed)! };
}

export function resolveEstimateAmountForPipelineAdvance(
  existingEstimateAmount: number | null,
  formEstimateAmountRaw: string,
): { estimateAmount: number } | { error: string } {
  const normalizedExisting = normalizeEstimateAmount(existingEstimateAmount);

  if (normalizedExisting !== null) {
    const trimmed = formEstimateAmountRaw.trim();

    if (trimmed) {
      return parseEstimateAmountInput(trimmed);
    }

    return { estimateAmount: normalizedExisting };
  }

  return parseEstimateAmountInput(formEstimateAmountRaw);
}

export function resolveEstimateActivity(
  existingEstimateSentAt: string | null,
  existingEstimateAmount: number | null,
  newEstimateAmount: number,
  statusChangingToEstimateSent: boolean,
): EstimateActivityKind {
  if (statusChangingToEstimateSent && existingEstimateSentAt === null) {
    return "sent";
  }

  const normalizedExisting = normalizeEstimateAmount(existingEstimateAmount);

  if (
    !statusChangingToEstimateSent &&
    normalizedExisting !== null &&
    normalizedExisting !== newEstimateAmount
  ) {
    return "updated";
  }

  return "none";
}

export function resolveEstimateSentAtUpdate(
  existingEstimateSentAt: string | null,
  statusChangingToEstimateSent: boolean,
  now: Date = new Date(),
): string | undefined {
  if (!statusChangingToEstimateSent || existingEstimateSentAt !== null) {
    return undefined;
  }

  return now.toISOString();
}

export function planEstimateSendFromDetail(input: {
  currentStatus: LeadStatus;
  existingEstimateAmount: number | null;
  existingEstimateSentAt: string | null;
  newEstimateAmount: number;
}): EstimateSendPlan | { error: string } {
  const statusChangingToEstimateSent =
    input.currentStatus === "appointment_scheduled";
  const estimateActivity = resolveEstimateActivity(
    input.existingEstimateSentAt,
    input.existingEstimateAmount,
    input.newEstimateAmount,
    statusChangingToEstimateSent,
  );

  if (input.currentStatus === "appointment_scheduled") {
    return {
      estimateAmount: input.newEstimateAmount,
      nextStatus: "estimate_sent",
      statusChanged: true,
      estimateActivity,
    };
  }

  if (input.currentStatus === "estimate_sent") {
    return {
      estimateAmount: input.newEstimateAmount,
      nextStatus: "estimate_sent",
      statusChanged: false,
      estimateActivity,
    };
  }

  return {
    error:
      "Estimates can only be sent from leads in the Inspection scheduled stage or updated for leads already in the Estimate sent stage.",
  };
}

export function planPipelineEstimateAdvance(input: {
  existingEstimateAmount: number | null;
  existingEstimateSentAt: string | null;
  formEstimateAmountRaw: string;
}): EstimateSendPlan | { error: string } {
  const resolved = resolveEstimateAmountForPipelineAdvance(
    input.existingEstimateAmount,
    input.formEstimateAmountRaw,
  );

  if ("error" in resolved) {
    return resolved;
  }

  return {
    estimateAmount: resolved.estimateAmount,
    nextStatus: "estimate_sent",
    statusChanged: true,
    estimateActivity: resolveEstimateActivity(
      input.existingEstimateSentAt,
      input.existingEstimateAmount,
      resolved.estimateAmount,
      true,
    ),
  };
}

export function shouldIncludeEstimateAmountInUpdate(
  existingEstimateAmount: number | null,
  nextEstimateAmount: number,
): boolean {
  return (
    normalizeEstimateAmount(existingEstimateAmount) !== nextEstimateAmount
  );
}

export function formatEstimateSentSummary(
  estimateAmount: number,
  estimateSentAt: string,
): string {
  return `Estimate sent: ${formatLeadEstimateAmount(estimateAmount)} on ${formatLeadAppointmentAt(estimateSentAt)}`;
}

export function formatEstimateUpdatedSummary(estimateAmount: number): string {
  return `Estimate updated to ${formatLeadEstimateAmount(estimateAmount)}`;
}
