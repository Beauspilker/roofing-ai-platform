import type { CollectedFields } from "@/lib/call-intake";
import {
  derivePhoneLeadPriorityLabel,
  type PhoneLeadPriorityLabel,
} from "@/lib/call-lead-crm";
import type { Company } from "@/lib/companies";
import type { Lead } from "@/lib/leads";
import { isValidIntakePhone, normalizePhoneDigits } from "@/lib/intake";

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function formatPhoneForTwilioSms(phone: string): string | null {
  const digits = normalizePhoneDigits(phone);

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

export function resolveCustomerPhone(
  lead: Lead,
  fields: CollectedFields,
  callerPhone: string | null,
): string | null {
  const candidates = [
    lead.phone,
    fields.callback_phone,
    callerPhone,
  ].filter(hasText);

  for (const candidate of candidates) {
    if (!isValidIntakePhone(candidate)) {
      continue;
    }

    const formatted = formatPhoneForTwilioSms(candidate);

    if (formatted) {
      return formatted;
    }
  }

  return null;
}

export function formatCustomerDisplayName(fullName: string | null | undefined): string {
  const trimmed = fullName?.trim();

  if (!trimmed || /^unknown caller$/i.test(trimmed)) {
    return "there";
  }

  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function buildCustomerConfirmationSms(input: {
  lead: Lead;
  company: Company;
  fields: CollectedFields;
}): string {
  const customerName = formatCustomerDisplayName(input.lead.full_name);
  const companyName = input.company.company_name.trim() || "our roofing team";
  const priorityLabel = derivePhoneLeadPriorityLabel(input.fields);

  const lines = [
    `Hi ${customerName},`,
    "",
    `Thanks for contacting ${companyName}.`,
    "",
    "We've received your roofing request and someone from our team will review it shortly.",
    "",
    "If this is an emergency involving active water intrusion or immediate safety concerns, please call us immediately.",
  ];

  if (hasText(input.fields.appointment_preference)) {
    lines.push(
      "",
      "Requested appointment:",
      input.fields.appointment_preference.trim(),
    );
  }

  if (priorityLabel === "Emergency") {
    lines.push(
      "",
      "Our team has marked your request as HIGH PRIORITY and will reach out as quickly as possible.",
    );
  }

  lines.push("", "Thank you!");

  return lines.join("\n").slice(0, 1500);
}

export function isCustomerConfirmationEnabled(
  smsFollowUpEnabled: boolean,
): boolean {
  return smsFollowUpEnabled;
}

export function getCustomerConfirmationPriorityLabel(
  fields: CollectedFields,
): PhoneLeadPriorityLabel {
  return derivePhoneLeadPriorityLabel(fields);
}
