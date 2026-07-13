import type { SupabaseClient } from "@supabase/supabase-js";
import { formatBusinessControlCenterSchemaError } from "@/lib/companies";

export const WEEKDAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
] as const;

export type WeekdayKey = (typeof WEEKDAYS)[number]["key"];

export type DayHours = {
  open: string;
  close: string;
};

export type BusinessHours = Partial<Record<WeekdayKey, DayHours>>;

export type BusinessSettings = {
  id: string;
  company_id: string;
  timezone: string;
  business_hours: BusinessHours;
  ai_phone_enabled: boolean;
  ai_greeting_message: string | null;
  ai_after_hours_message: string | null;
  appointment_buffer_minutes: number;
  default_estimate_valid_days: number;
  notification_email: string | null;
  missed_call_handling: MissedCallHandling | null;
  sms_follow_up_enabled: boolean;
  email_follow_up_enabled: boolean;
  appointment_reminders_enabled: boolean;
  after_hours_handling: AfterHoursHandling | null;
  created_at: string;
  updated_at: string;
};

export type MissedCallHandling =
  | "voicemail"
  | "sms_follow_up"
  | "manual_review";

export type AfterHoursHandling = "ai_message" | "voicemail" | "disabled";

export type BusinessSettingsInput = {
  timezone: string;
  business_hours: BusinessHours;
  ai_phone_enabled: boolean;
  ai_after_hours_message?: string | null;
  notification_email?: string | null;
  missed_call_handling?: MissedCallHandling | null;
  sms_follow_up_enabled: boolean;
  email_follow_up_enabled: boolean;
  appointment_reminders_enabled: boolean;
  after_hours_handling?: AfterHoursHandling | null;
};

export const MISSED_CALL_HANDLING_OPTIONS = [
  { value: "", label: "Not configured" },
  { value: "voicemail", label: "Send to voicemail" },
  { value: "sms_follow_up", label: "Send SMS follow-up" },
  { value: "manual_review", label: "Flag for manual review" },
] as const;

export const AFTER_HOURS_HANDLING_OPTIONS = [
  { value: "", label: "Not configured" },
  { value: "ai_message", label: "Play AI after-hours message" },
  { value: "voicemail", label: "Send to voicemail" },
  { value: "disabled", label: "Use standard business hours only" },
] as const;

export function isBusinessHoursEmpty(hours: BusinessHours): boolean {
  return WEEKDAYS.every((day) => {
    const entry = hours[day.key];
    return !entry?.open || !entry?.close;
  });
}

export function parseBusinessHoursFromFormData(
  formData: FormData,
): BusinessHours {
  const hours: BusinessHours = {};

  for (const day of WEEKDAYS) {
    const open = formData.get(`${day.key}_open`)?.toString().trim() ?? "";
    const close = formData.get(`${day.key}_close`)?.toString().trim() ?? "";

    // Prefer entered times over the closed checkbox. Days default to "Closed"
    // checked in the UI, which previously caused hours to be dropped on save.
    if (open && close) {
      hours[day.key] = { open, close };
      continue;
    }

    if (parseCheckbox(formData, `${day.key}_closed`)) {
      continue;
    }
  }

  return hours;
}

export function getDayHours(
  hours: BusinessHours,
  dayKey: WeekdayKey,
): DayHours | null {
  const entry = hours[dayKey];
  if (!entry?.open || !entry?.close) {
    return null;
  }

  return entry;
}

function normalizeTimeValue(value: string): string {
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value.slice(0, 5);
  }

  return value;
}

function parseBusinessHours(value: unknown): BusinessHours {
  if (!value || typeof value !== "object") {
    return {};
  }

  const hours: BusinessHours = {};

  for (const day of WEEKDAYS) {
    const entry = (value as Record<string, unknown>)[day.key];
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const open =
      "open" in entry && typeof entry.open === "string"
        ? normalizeTimeValue(entry.open)
        : "";
    const close =
      "close" in entry && typeof entry.close === "string"
        ? normalizeTimeValue(entry.close)
        : "";

    if (open && close) {
      hours[day.key] = { open, close };
    }
  }

  return hours;
}

function parseMissedCallHandling(value: string): MissedCallHandling | null {
  if (
    value === "voicemail" ||
    value === "sms_follow_up" ||
    value === "manual_review"
  ) {
    return value;
  }

  return null;
}

function parseAfterHoursHandling(value: string): AfterHoursHandling | null {
  if (value === "ai_message" || value === "voicemail" || value === "disabled") {
    return value;
  }

  return null;
}

function parseCheckbox(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "true" || value === "on";
}

export function parseBusinessSettingsFormData(formData: FormData): {
  settings: BusinessSettingsInput;
  error?: string;
} {
  const timezone = formData.get("timezone")?.toString().trim() || "America/Chicago";
  const businessHours = parseBusinessHoursFromFormData(formData);
  const aiAfterHoursMessage =
    formData.get("ai_after_hours_message")?.toString().trim() ?? "";
  const notificationEmail =
    formData.get("notification_email")?.toString().trim() ?? "";
  const missedCallRaw =
    formData.get("missed_call_handling")?.toString().trim() ?? "";
  const afterHoursRaw =
    formData.get("after_hours_handling")?.toString().trim() ?? "";

  return {
    settings: {
      timezone,
      business_hours: businessHours,
      ai_phone_enabled: parseCheckbox(formData, "ai_phone_enabled"),
      ai_after_hours_message: aiAfterHoursMessage || null,
      notification_email: notificationEmail || null,
      missed_call_handling: parseMissedCallHandling(missedCallRaw),
      sms_follow_up_enabled: parseCheckbox(formData, "sms_follow_up_enabled"),
      email_follow_up_enabled: parseCheckbox(formData, "email_follow_up_enabled"),
      appointment_reminders_enabled: parseCheckbox(
        formData,
        "appointment_reminders_enabled",
      ),
      after_hours_handling: parseAfterHoursHandling(afterHoursRaw),
    },
  };
}

export async function getBusinessSettingsByCompanyId(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BusinessSettings | null> {
  const { data, error } = await supabase
    .from("business_settings")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    ...data,
    business_hours: parseBusinessHours(data.business_hours),
  };
}

export async function upsertBusinessSettings(
  supabase: SupabaseClient,
  companyId: string,
  input: BusinessSettingsInput,
): Promise<BusinessSettings> {
  const payload = {
    company_id: companyId,
    timezone: input.timezone,
    business_hours: input.business_hours,
    ai_phone_enabled: input.ai_phone_enabled,
    ai_after_hours_message: input.ai_after_hours_message ?? null,
    notification_email: input.notification_email ?? null,
    missed_call_handling: input.missed_call_handling ?? null,
    sms_follow_up_enabled: input.sms_follow_up_enabled,
    email_follow_up_enabled: input.email_follow_up_enabled,
    appointment_reminders_enabled: input.appointment_reminders_enabled,
    after_hours_handling: input.after_hours_handling ?? null,
  };

  const { data, error } = await supabase
    .from("business_settings")
    .upsert(payload, { onConflict: "company_id" })
    .select("*")
    .single();

  if (error) {
    throw new Error(formatBusinessControlCenterSchemaError(error.message));
  }

  if (!data) {
    throw new Error("Failed to save business settings.");
  }

  return {
    ...data,
    business_hours: parseBusinessHours(data.business_hours),
  };
}
