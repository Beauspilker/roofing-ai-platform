import type { SupabaseClient } from "@supabase/supabase-js";

export const NOTIFICATION_CHANNELS = ["sms", "email"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  "simulated",
  "queued",
  "sent",
  "failed",
] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export type Notification = {
  id: string;
  company_id: string;
  lead_id: string | null;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  message: string;
  status: NotificationStatus;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  notification_kind?: string | null;
};

export type CreateNotificationInput = {
  companyId: string;
  leadId: string;
  channel: NotificationChannel;
  recipient: string;
  subject?: string | null;
  message: string;
  notificationKind?: string | null;
  status?: NotificationStatus;
  errorMessage?: string | null;
  sentAt?: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function formatNotificationChannel(channel: NotificationChannel): string {
  return channel === "sms" ? "SMS" : "Email";
}

export function formatNotificationStatus(status: NotificationStatus): string {
  switch (status) {
    case "simulated":
      return "Simulated";
    case "queued":
      return "Queued";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function formatNotificationDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

export function formatNotificationTime(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

export function formatNotificationPreview(message: string, maxLength = 120): string {
  const trimmed = message.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength).trimEnd()}...`;
}

export function parseNotificationChannel(value: string): NotificationChannel | null {
  if (value === "sms" || value === "email") {
    return value;
  }

  return null;
}

export function validateNotificationInput({
  channel,
  recipient,
  subject,
  message,
}: {
  channel: NotificationChannel | null;
  recipient: string;
  subject: string;
  message: string;
}): string | null {
  if (!channel) {
    return "Please choose SMS or Email.";
  }

  const trimmedRecipient = recipient.trim();
  const trimmedMessage = message.trim();
  const trimmedSubject = subject.trim();

  if (!trimmedMessage) {
    return "Message is required.";
  }

  if (channel === "sms") {
    if (!trimmedRecipient) {
      return "SMS notifications require a phone number.";
    }

    return null;
  }

  if (!trimmedRecipient) {
    return "Email notifications require an email address.";
  }

  if (!EMAIL_PATTERN.test(trimmedRecipient)) {
    return "Please enter a valid email address.";
  }

  if (!trimmedSubject) {
    return "Subject is required for email notifications.";
  }

  return null;
}

export async function getNotificationsByLeadId(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function createSimulatedNotification(
  supabase: SupabaseClient,
  input: CreateNotificationInput,
): Promise<Notification> {
  const { data, error } = await supabase
    .from("notifications")
    .insert({
      company_id: input.companyId,
      lead_id: input.leadId,
      channel: input.channel,
      recipient: input.recipient.trim(),
      subject: input.channel === "email" ? input.subject?.trim() || null : null,
      message: input.message.trim(),
      status: "simulated",
      sent_at: null,
      error_message: null,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Failed to create notification record.");
  }

  return data;
}

export async function createEmployeeNotificationRecord(
  supabase: SupabaseClient,
  input: CreateNotificationInput,
): Promise<Notification> {
  const { data, error } = await supabase
    .from("notifications")
    .insert({
      company_id: input.companyId,
      lead_id: input.leadId,
      channel: input.channel,
      recipient: input.recipient.trim(),
      subject: input.channel === "email" ? input.subject?.trim() || null : null,
      message: input.message.trim(),
      status: input.status ?? "queued",
      sent_at: input.sentAt ?? null,
      error_message: input.errorMessage ?? null,
      notification_kind: input.notificationKind ?? null,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Failed to create notification record.");
  }

  return data;
}

export async function getEmployeeNotificationForLead(
  supabase: SupabaseClient,
  leadId: string,
  channel: NotificationChannel,
  notificationKind: string,
): Promise<Notification | null> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("lead_id", leadId)
    .eq("channel", channel)
    .eq("notification_kind", notificationKind)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}
