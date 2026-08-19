import { normalizeEstimateAmount } from "@/lib/lead-estimate";
import { isActiveLead, isArchivedLead, type Lead } from "@/lib/leads";

export type LeadPipelineValueVisibility = {
  openPipelineValue: number;
  openPipelineLeadCount: number;
  wonRevenue: number;
  wonLeadCount: number;
};

export function contributesToOpenPipelineValue(lead: Lead): boolean {
  if (!isActiveLead(lead) || isArchivedLead(lead)) {
    return false;
  }

  if (!lead.estimate_sent_at) {
    return false;
  }

  const amount = normalizeEstimateAmount(lead.estimate_amount);

  return amount !== null && amount > 0;
}

export function contributesToWonRevenue(lead: Lead): boolean {
  if (isArchivedLead(lead) || lead.status !== "won") {
    return false;
  }

  const amount = normalizeEstimateAmount(lead.estimate_amount);

  return amount !== null && amount > 0;
}

export function computeLeadPipelineValueVisibility(
  leads: Lead[],
): LeadPipelineValueVisibility {
  let openPipelineValue = 0;
  let openPipelineLeadCount = 0;
  let wonRevenue = 0;
  let wonLeadCount = 0;

  for (const lead of leads) {
    if (contributesToOpenPipelineValue(lead)) {
      openPipelineValue += normalizeEstimateAmount(lead.estimate_amount)!;
      openPipelineLeadCount += 1;
    }

    if (contributesToWonRevenue(lead)) {
      wonRevenue += normalizeEstimateAmount(lead.estimate_amount)!;
      wonLeadCount += 1;
    }
  }

  return {
    openPipelineValue,
    openPipelineLeadCount,
    wonRevenue,
    wonLeadCount,
  };
}
