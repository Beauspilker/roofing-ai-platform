import type { CollectedFields } from "@/lib/call-intake";
import { buildCrmCallSummary } from "@/lib/call-summary";
import {
  derivePhoneLeadPriorityLabel,
  type PhoneLeadPriorityLabel,
} from "@/lib/call-lead-crm";
import type { CallSession } from "@/lib/call-sessions";
import type { Lead } from "@/lib/leads";
import { getBusinessSettingsByCompanyId } from "@/lib/business-settings";
import type { Company } from "@/lib/companies";
import { createServiceClient } from "@/lib/supabase/service";

export const EMPLOYEE_PHONE_AI_LEAD_KIND = "employee_phone_ai_lead";

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

export function buildEmployeeLeadNotificationContent(input: {
  lead: Lead;
  fields: CollectedFields;
  callSid: string;
  conversationId: string;
  dashboardUrl: string | null;
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
      ? `URGENT PHONE AI LEAD — ${displayValue(input.lead.full_name)}${priorityReason ? ` — ${priorityReason}` : ""}`
      : `New Phone AI Lead — ${displayValue(input.lead.full_name)}`;

  const smsBody =
    style === "urgent"
      ? `${smsSubjectLine}\n\n${body}`.slice(0, 1500)
      : `${smsSubjectLine}\n\n${body}`.slice(0, 1500);

  return {
    style,
    priorityLabel,
    priorityReason,
    smsSubjectLine,
    emailSubject,
    smsBody,
    emailBody: `${emailSubject}\n\n${body}`,
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
): Promise<EmployeeNotificationRecipients> {
  const supabase = createServiceClient();
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

export function pickSmsRecipient(
  recipients: EmployeeNotificationRecipients,
  style: EmployeeNotificationStyle,
): string | null {
  if (!recipients.smsEnabled) {
    return null;
  }

  if (style === "urgent") {
    return recipients.emergencySmsRecipient ?? recipients.smsRecipient;
  }

  return recipients.smsRecipient;
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
