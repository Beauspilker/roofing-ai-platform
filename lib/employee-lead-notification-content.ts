import type { CollectedFields } from "@/lib/call-intake";
import { buildCrmCallSummary } from "@/lib/call-summary";
import { formatPhoneForTwilioSms } from "@/lib/customer-confirmation-content";
import {
  derivePhoneLeadPriorityLabel,
  type PhoneLeadPriorityLabel,
} from "@/lib/call-lead-crm";
import type { CallSession } from "@/lib/call-sessions";
import type { IntakeAnswers, IntakeUrgency } from "@/lib/intake";
import type { Lead } from "@/lib/leads";
import { getBusinessSettingsByCompanyId } from "@/lib/business-settings";
import type { Company } from "@/lib/companies";
import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";

export const EMPLOYEE_PHONE_AI_LEAD_KIND = "employee_phone_ai_lead";
export const EMPLOYEE_WEBSITE_LEAD_KIND = "employee_website_lead";

export type EmployeeNotificationStyle = "normal" | "urgent";

export type EmployeeLeadNotificationContent = {
  style: EmployeeNotificationStyle;
  priorityLabel: PhoneLeadPriorityLabel;
  priorityReason: string | null;
  smsSubjectLine: string;
  emailSubject: string;
  smsBody: string;
  emailBody: string;
};

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function displayValue(value: string | null | undefined, fallback = "Not provided"): string {
  return hasText(value) ? value.trim() : fallback;
}

function isAffirmative(value: string | undefined): boolean {
  return (
    hasText(value) &&
    /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim())
  );
}

export function resolveEmployeeNotificationStyle(
  priorityLabel: PhoneLeadPriorityLabel,
): EmployeeNotificationStyle {
  return priorityLabel === "Emergency" || priorityLabel === "High"
    ? "urgent"
    : "normal";
}

export function buildEmployeePriorityReason(
  fields: CollectedFields,
  priorityLabel: PhoneLeadPriorityLabel,
): string | null {
  if (priorityLabel === "Emergency") {
    if (fields.emergency_acknowledged) {
      return "Emergency urgency was detected during the call.";
    }

    return "Caller reported an emergency roofing situation.";
  }

  if (priorityLabel === "High") {
    if (isAffirmative(fields.active_leak)) {
      return "Active water intrusion was reported.";
    }

    if (fields.urgency?.toLowerCase().includes("urgent")) {
      return "Caller requested urgent attention.";
    }

    return "Lead was marked high priority based on urgency signals.";
  }

  return null;
}

export function buildConciseEmployeeLeadEmailBody(input: {
  companyName?: string | null;
  lead: Lead;
  issue: string;
  priorityLabel: PhoneLeadPriorityLabel;
  dashboardUrl: string | null;
}): string {
  const lines = ["New Roofing Lead", ""];

  if (hasText(input.companyName)) {
    lines.push(`Company: ${input.companyName.trim()}`, "");
  }

  lines.push(
    `Customer: ${displayValue(input.lead.full_name)}`,
    `Phone: ${displayValue(input.lead.phone)}`,
    `Issue: ${input.issue}`,
    `Priority: ${input.priorityLabel}`,
  );

  if (hasText(input.lead.address_line_1)) {
    lines.push(`Address: ${input.lead.address_line_1.trim()}`);
  }

  if (input.dashboardUrl) {
    lines.push("", "Open Lead:", input.dashboardUrl);
  }

  return lines.join("\n");
}

export function buildEmployeeLeadNotificationContent(input: {
  lead: Lead;
  fields: CollectedFields;
  callSid: string;
  conversationId: string;
  dashboardUrl: string | null;
  companyName?: string | null;
}): EmployeeLeadNotificationContent {
  const priorityLabel = derivePhoneLeadPriorityLabel(input.fields);
  const style = resolveEmployeeNotificationStyle(priorityLabel);
  const priorityReason = buildEmployeePriorityReason(
    input.fields,
    priorityLabel,
  );
  const summary = input.fields.crm_summary ?? buildCrmCallSummary(input.fields);
  const issue =
    displayValue(input.fields.problem_description) !== "Not provided"
      ? displayValue(input.fields.problem_description)
      : displayValue(input.fields.project_type);

  const lines = [
    `Customer: ${displayValue(input.lead.full_name)}`,
    `Phone: ${displayValue(input.lead.phone)}`,
    `Address: ${displayValue(input.lead.address_line_1)}`,
    `Priority: ${priorityLabel}`,
    ...(priorityReason ? [`Why urgent: ${priorityReason}`] : []),
    `Issue: ${issue}`,
    `Active leak: ${displayValue(input.fields.active_leak)}`,
    `Insurance: ${input.lead.insurance_claim ? "Yes" : displayValue(input.fields.insurance_claim, "No")}`,
    `Appointment: ${displayValue(input.fields.appointment_preference)}`,
    `Source: Phone AI`,
    "",
    "Summary:",
    summary,
  ];

  if (input.dashboardUrl) {
    lines.push("", `View lead: ${input.dashboardUrl}`);
  }

  const body = lines.join("\n");

  const smsSubjectLine =
    style === "urgent" ? "URGENT PHONE AI LEAD" : "New Phone AI Lead";

  const emailSubject =
    style === "urgent"
      ? `URGENT: New Roofing Lead — ${displayValue(input.lead.full_name)}`
      : `New Roofing Lead — ${displayValue(input.lead.full_name)}`;

  const smsBody =
    style === "urgent"
      ? `${smsSubjectLine}\n\n${body}`.slice(0, 1500)
      : `${smsSubjectLine}\n\n${body}`.slice(0, 1500);

  const emailBody = buildConciseEmployeeLeadEmailBody({
    companyName: input.companyName,
    lead: input.lead,
    issue,
    priorityLabel,
    dashboardUrl: input.dashboardUrl,
  });

  return {
    style,
    priorityLabel,
    priorityReason,
    smsSubjectLine,
    emailSubject,
    smsBody,
    emailBody,
  };
}

export function getLeadDashboardUrl(leadId: string): string | null {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim();

  if (!configured) {
    return null;
  }

  const origin = configured.startsWith("http")
    ? configured.replace(/\/$/, "")
    : `https://${configured.replace(/\/$/, "")}`;

  return `${origin}/dashboard/leads/${leadId}`;
}

export type EmployeeNotificationRecipients = {
  smsRecipient: string | null;
  emailRecipient: string | null;
  emergencySmsRecipient: string | null;
  emergencyEmailRecipient: string | null;
  smsEnabled: boolean;
  emailEnabled: boolean;
};

export async function resolveEmployeeNotificationRecipients(
  company: Company,
  supabaseClient?: SupabaseClient | null,
): Promise<EmployeeNotificationRecipients> {
  const supabase = supabaseClient ?? createServiceClient();
  const settings = supabase
    ? await getBusinessSettingsByCompanyId(supabase, company.id)
    : null;

  const smsEnabled = settings?.sms_follow_up_enabled ?? false;
  const emailEnabled = settings?.email_follow_up_enabled ?? false;

  const smsRecipient = hasText(company.business_phone)
    ? company.business_phone.trim()
    : null;

  const emailRecipient =
    settings?.notification_email?.trim() ||
    company.business_email?.trim() ||
    null;

  return {
    smsRecipient,
    emailRecipient,
    emergencySmsRecipient: smsRecipient,
    emergencyEmailRecipient: emailRecipient,
    smsEnabled,
    emailEnabled,
  };
}

function normalizeEmployeeSmsRecipient(phone: string | null): string | null {
  if (!phone) {
    return null;
  }

  const trimmed = phone.trim();
  return formatPhoneForTwilioSms(trimmed) ?? trimmed;
}

export function pickSmsRecipient(
  recipients: EmployeeNotificationRecipients,
  style: EmployeeNotificationStyle,
): string | null {
  if (!recipients.smsEnabled) {
    return null;
  }

  const rawRecipient =
    style === "urgent"
      ? recipients.emergencySmsRecipient ?? recipients.smsRecipient
      : recipients.smsRecipient;

  return normalizeEmployeeSmsRecipient(rawRecipient);
}

export function pickEmailRecipient(
  recipients: EmployeeNotificationRecipients,
  style: EmployeeNotificationStyle,
): string | null {
  if (!recipients.emailEnabled) {
    return null;
  }

  if (style === "urgent") {
    return recipients.emergencyEmailRecipient ?? recipients.emailRecipient;
  }

  return recipients.emailRecipient;
}

export function deriveWebsiteLeadPriorityLabel(
  urgency: IntakeUrgency | "",
): PhoneLeadPriorityLabel {
  if (urgency === "emergency") {
    return "Emergency";
  }

  if (urgency === "standard") {
    return "Medium";
  }

  return "Low";
}

export function buildWebsiteLeadNotificationContent(input: {
  lead: Lead;
  answers: IntakeAnswers;
  dashboardUrl: string | null;
  companyName?: string | null;
}): EmployeeLeadNotificationContent {
  const priorityLabel = deriveWebsiteLeadPriorityLabel(input.answers.urgency);
  const style = resolveEmployeeNotificationStyle(priorityLabel);
  const issue = displayValue(input.answers.description);
  const priorityReason =
    priorityLabel === "Emergency"
      ? "Homeowner marked this as an emergency request."
      : null;

  const lines = [
    `Customer: ${displayValue(input.lead.full_name)}`,
    `Phone: ${displayValue(input.lead.phone)}`,
    ...(hasText(input.lead.email) ? [`Email: ${input.lead.email.trim()}`] : []),
    `Address: ${displayValue(input.lead.address_line_1)}`,
    `City: ${displayValue(input.lead.city)}`,
    `State: ${displayValue(input.lead.state)}`,
    `ZIP: ${displayValue(input.lead.postal_code)}`,
    `Project: ${displayValue(input.answers.project_type)}`,
    `Priority: ${priorityLabel}`,
    ...(priorityReason ? [`Why urgent: ${priorityReason}`] : []),
    `Issue: ${issue}`,
    `Insurance: ${input.lead.insurance_claim ? "Yes" : "No"}`,
    `Source: Website`,
  ];

  if (input.dashboardUrl) {
    lines.push("", `View lead: ${input.dashboardUrl}`);
  }

  const body = lines.join("\n");

  const smsSubjectLine =
    style === "urgent" ? "URGENT WEBSITE LEAD" : "New Website Lead";

  const emailSubject =
    style === "urgent"
      ? `URGENT: New Website Lead — ${displayValue(input.lead.full_name)}`
      : `New Website Lead — ${displayValue(input.lead.full_name)}`;

  const smsBody = `${smsSubjectLine}\n\n${body}`.slice(0, 1500);

  const emailBody = buildConciseEmployeeLeadEmailBody({
    companyName: input.companyName,
    lead: input.lead,
    issue,
    priorityLabel,
    dashboardUrl: input.dashboardUrl,
  });

  return {
    style,
    priorityLabel,
    priorityReason,
    smsSubjectLine,
    emailSubject,
    smsBody,
    emailBody,
  };
}

export function buildEmployeeNotificationContext(input: {
  session: CallSession;
  lead: Lead;
  company: Company;
}): {
  fields: CollectedFields;
  conversationId: string;
  callSid: string;
} {
  return {
    fields: input.session.collected_fields ?? {},
    conversationId: input.session.id,
    callSid: input.session.twilio_call_sid,
  };
}
