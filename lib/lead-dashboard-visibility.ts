import { isFollowUpOverdue } from "@/lib/lead-follow-up";
import { PIPELINE_STAGES } from "@/lib/lead-pipeline";
import {
  computeLeadDashboardStats,
  isActiveLead,
  isArchivedLead,
  type Lead,
  type LeadDashboardStats,
  type LeadStatus,
} from "@/lib/leads";

export const ACTIVE_PIPELINE_STAGES = PIPELINE_STAGES.slice(
  0,
  -1,
) as readonly Exclude<(typeof PIPELINE_STAGES)[number], "won">[];

export type PipelineStageCounts = Record<
  (typeof ACTIVE_PIPELINE_STAGES)[number],
  number
>;

export type LeadPipelineVisibility = {
  pipelineStageCounts: PipelineStageCounts;
  wonCount: number;
  lostCount: number;
  followUpsDue: number;
  followUpsOverdue: number;
};

export type LeadDashboardVisibility = {
  stats: LeadDashboardStats;
  pipeline: LeadPipelineVisibility;
};

function emptyPipelineStageCounts(): PipelineStageCounts {
  return {
    new: 0,
    contacted: 0,
    appointment_scheduled: 0,
    estimate_sent: 0,
  };
}

export function computeLeadPipelineVisibility(
  leads: Lead[],
  now: Date = new Date(),
): LeadPipelineVisibility {
  const pipelineStageCounts = emptyPipelineStageCounts();
  let wonCount = 0;
  let lostCount = 0;
  let followUpsDue = 0;
  let followUpsOverdue = 0;

  for (const lead of leads) {
    if (isArchivedLead(lead)) {
      continue;
    }

    if (lead.status === "won") {
      wonCount += 1;
    } else if (lead.status === "lost") {
      lostCount += 1;
    }

    if (!isActiveLead(lead)) {
      continue;
    }

    if (lead.status in pipelineStageCounts) {
      pipelineStageCounts[lead.status as keyof PipelineStageCounts] += 1;
    }

    if (lead.follow_up_at) {
      followUpsDue += 1;

      if (isFollowUpOverdue(lead.follow_up_at, now)) {
        followUpsOverdue += 1;
      }
    }
  }

  return {
    pipelineStageCounts,
    wonCount,
    lostCount,
    followUpsDue,
    followUpsOverdue,
  };
}

export function computeLeadDashboardVisibility(
  leads: Lead[],
  now: Date = new Date(),
): LeadDashboardVisibility {
  return {
    stats: computeLeadDashboardStats(leads),
    pipeline: computeLeadPipelineVisibility(leads, now),
  };
}

export function buildDashboardStatusFilterHref(status: LeadStatus): string {
  return `/dashboard?status=${encodeURIComponent(status)}#lead-list`;
}

export function buildDashboardFollowUpFilterHref(
  followUp: "due" | "overdue",
): string {
  return `/dashboard?followUp=${encodeURIComponent(followUp)}#lead-list`;
}
