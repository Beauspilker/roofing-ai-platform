import {
  formatLeadEstimateAmount,
  formatLeadFieldValue,
  type Lead,
} from "@/lib/leads";

export function formatLeadListPhone(phone: string | null): string {
  return formatLeadFieldValue(phone);
}

export function shouldShowEstimateHint(lead: Lead): boolean {
  return (
    (lead.status === "estimate_sent" || lead.status === "won") &&
    lead.estimate_amount !== null
  );
}

export function formatLeadListEstimateHint(lead: Lead): string {
  if (!shouldShowEstimateHint(lead) || lead.estimate_amount === null) {
    return "";
  }

  return formatLeadEstimateAmount(lead.estimate_amount);
}

export function hasContactPhone(phone: string | null | undefined): boolean {
  return typeof phone === "string" && phone.trim().length > 0;
}

export function hasContactEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().length > 0;
}
