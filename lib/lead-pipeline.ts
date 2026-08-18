import {
  formatLeadStatus,
  isLeadStatus,
  type LeadStatus,
} from "@/lib/leads";

export const PIPELINE_STAGES = [
  "new",
  "contacted",
  "appointment_scheduled",
  "estimate_sent",
  "won",
] as const satisfies readonly LeadStatus[];

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const LOST_ELIGIBLE_STATUSES = new Set<LeadStatus>([
  "new",
  "contacted",
  "appointment_scheduled",
  "estimate_sent",
]);

export function getNextPipelineStatus(current: string): LeadStatus | null {
  if (!isLeadStatus(current)) {
    return null;
  }

  const index = PIPELINE_STAGES.indexOf(current as PipelineStage);

  if (index === -1 || index >= PIPELINE_STAGES.length - 1) {
    return null;
  }

  return PIPELINE_STAGES[index + 1];
}

export function canMarkLeadAsLost(current: string): boolean {
  return isLeadStatus(current) && LOST_ELIGIBLE_STATUSES.has(current);
}

export function isPipelineTerminalStatus(status: string): boolean {
  return status === "won" || status === "lost" || status === "archived";
}

export function isAllowedPipelineStatusTransition(
  from: string,
  to: string,
): boolean {
  if (!isLeadStatus(from) || !isLeadStatus(to) || from === to) {
    return false;
  }

  if (to === "lost") {
    return canMarkLeadAsLost(from);
  }

  return getNextPipelineStatus(from) === to;
}

export function formatStatusChangeSummary(
  previousStatus: string,
  updatedStatus: string,
): string {
  return `Status changed: ${formatLeadStatus(previousStatus)} → ${formatLeadStatus(updatedStatus)}`;
}

export function getPipelineStageIndex(status: string): number {
  return PIPELINE_STAGES.indexOf(status as PipelineStage);
}

export function isActionablePipelineStage(
  currentStatus: string,
  targetStage: string,
): boolean {
  return getNextPipelineStatus(currentStatus) === targetStage;
}
