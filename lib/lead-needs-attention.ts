import { isFollowUpOverdue } from "@/lib/lead-follow-up";
import { isInspectionOverdue } from "@/lib/lead-inspection-visibility";
import {
  isActiveLead,
  isArchivedLead,
  isLeadAwaitingContact,
  isLeadNeedingAttention,
  type Lead,
} from "@/lib/leads";

export type LeadNeedsAttentionVisibility = {
  needsAttentionCount: number;
  awaitingContactCount: number;
  overdueFollowUpCount: number;
  overdueInspectionCount: number;
};

export { isLeadNeedingAttention };

export function computeLeadNeedsAttentionVisibility(
  leads: Lead[],
  now: Date = new Date(),
): LeadNeedsAttentionVisibility {
  let needsAttentionCount = 0;
  let awaitingContactCount = 0;
  let overdueFollowUpCount = 0;
  let overdueInspectionCount = 0;

  for (const lead of leads) {
    if (!isActiveLead(lead) || isArchivedLead(lead)) {
      continue;
    }

    const awaitingContact = isLeadAwaitingContact(lead);
    const overdueFollowUp = isFollowUpOverdue(lead.follow_up_at, now);
    const overdueInspection = isInspectionOverdue(lead.appointment_at, now);

    if (awaitingContact) {
      awaitingContactCount += 1;
    }

    if (overdueFollowUp) {
      overdueFollowUpCount += 1;
    }

    if (overdueInspection) {
      overdueInspectionCount += 1;
    }

    if (isLeadNeedingAttention(lead, now)) {
      needsAttentionCount += 1;
    }
  }

  return {
    needsAttentionCount,
    awaitingContactCount,
    overdueFollowUpCount,
    overdueInspectionCount,
  };
}
