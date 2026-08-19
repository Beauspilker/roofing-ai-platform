import type { ActivityHistory, ActivityType } from "@/lib/activity";
import { formatLostReasonLabel } from "@/lib/lead-outcome";
import {
  formatLeadAppointmentAt,
  formatLeadEstimateAmount,
  formatLeadStatus,
  getSourceLabel,
} from "@/lib/leads";

export type ActivityTimelineTone =
  | "pipeline"
  | "inspection"
  | "estimate"
  | "followUp"
  | "outcome"
  | "lead"
  | "call"
  | "notification"
  | "note"
  | "photo"
  | "website"
  | "archive"
  | "neutral";

const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  lead_created: "Lead",
  call_received: "Call",
  call_missed: "Call",
  note_added: "Note",
  photo_uploaded: "Photo",
  status_changed: "Pipeline",
  appointment_booked: "Inspection",
  appointment_updated: "Inspection",
  estimate_created: "Estimate",
  estimate_sent: "Estimate",
  settings_updated: "Settings",
  notification_queued: "Notification",
  website_lead_captured: "Website",
  follow_up_scheduled: "Follow-up",
  follow_up_rescheduled: "Follow-up",
  follow_up_completed: "Follow-up",
};

const ACTIVITY_TYPE_TONES: Record<ActivityType, ActivityTimelineTone> = {
  lead_created: "lead",
  call_received: "call",
  call_missed: "call",
  note_added: "note",
  photo_uploaded: "photo",
  status_changed: "pipeline",
  appointment_booked: "inspection",
  appointment_updated: "inspection",
  estimate_created: "estimate",
  estimate_sent: "estimate",
  settings_updated: "neutral",
  notification_queued: "notification",
  website_lead_captured: "website",
  follow_up_scheduled: "followUp",
  follow_up_rescheduled: "followUp",
  follow_up_completed: "followUp",
};

const CALL_EVENT_LABELS: Record<string, string> = {
  summary_generated: "AI call summary prepared",
  customer_confirmed: "Customer confirmed details",
};

const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  employee_phone_ai_lead: "Employee alert (AI phone lead)",
  employee_website_lead: "Employee alert (website lead)",
  customer_confirmation_sms: "Customer confirmation SMS",
};

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function readMetadataNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pushDetail(details: string[], line: string | null): void {
  if (!line || details.includes(line)) {
    return;
  }

  details.push(line);
}

function formatMetadataSource(source: string): string {
  if (source === "homeowner_landing") {
    return "Homeowner landing";
  }

  if (source === "Phone AI") {
    return "AI phone";
  }

  return getSourceLabel(source);
}

function formatPipelineSource(source: string): string {
  switch (source) {
    case "pipeline":
      return "Sales pipeline";
    case "edit_form":
      return "Lead edit form";
    case "schedule_form":
      return "Inspection form";
    case "send_form":
      return "Estimate form";
    case "won_form":
      return "Won form";
    case "follow_up_form":
      return "Follow-up form";
    default:
      return source.replaceAll("_", " ");
  }
}

function getStatusChangedLabel(metadata: Record<string, unknown>): string {
  const outcome = readMetadataString(metadata, "outcome");
  const event = readMetadataString(metadata, "event");

  if (outcome === "won" || outcome === "lost") {
    return "Outcome";
  }

  if (event === "lead_archived" || event === "lead_restored") {
    return "Archive";
  }

  return ACTIVITY_TYPE_LABELS.status_changed;
}

function getStatusChangedTone(metadata: Record<string, unknown>): ActivityTimelineTone {
  const outcome = readMetadataString(metadata, "outcome");
  const event = readMetadataString(metadata, "event");

  if (outcome === "won" || outcome === "lost") {
    return "outcome";
  }

  if (event === "lead_archived" || event === "lead_restored") {
    return "archive";
  }

  return ACTIVITY_TYPE_TONES.status_changed;
}

export function getActivityTypeLabel(activity: ActivityHistory): string {
  if (activity.activity_type === "status_changed") {
    return getStatusChangedLabel(activity.metadata);
  }

  return ACTIVITY_TYPE_LABELS[activity.activity_type] ?? "Activity";
}

export function getActivityTypeTone(activity: ActivityHistory): ActivityTimelineTone {
  if (activity.activity_type === "status_changed") {
    return getStatusChangedTone(activity.metadata);
  }

  return ACTIVITY_TYPE_TONES[activity.activity_type] ?? "neutral";
}

export function getActivityTypeToneClassName(
  tone: ActivityTimelineTone,
): string {
  switch (tone) {
    case "pipeline":
      return "text-blue-300";
    case "inspection":
      return "text-indigo-300";
    case "estimate":
      return "text-cyan-300";
    case "followUp":
      return "text-amber-200";
    case "outcome":
      return "text-green-300";
    case "lead":
      return "text-blue-200";
    case "call":
      return "text-purple-300";
    case "notification":
      return "text-gray-300";
    case "note":
      return "text-gray-300";
    case "photo":
      return "text-gray-300";
    case "website":
      return "text-blue-200";
    case "archive":
      return "text-gray-400";
    default:
      return "text-gray-500";
  }
}

function getPhotoUploadedDetails(metadata: Record<string, unknown>): string[] {
  const details: string[] = [];
  pushDetail(details, readMetadataString(metadata, "file_name"));
  return details;
}

function getNotificationQueuedDetails(
  metadata: Record<string, unknown>,
): string[] {
  const details: string[] = [];
  const channel = readMetadataString(metadata, "channel");
  const recipient = readMetadataString(metadata, "recipient");
  const notificationKind = readMetadataString(metadata, "notification_kind");

  if (channel === "sms" && recipient) {
    pushDetail(details, `SMS to ${recipient}`);
  } else if (channel === "email" && recipient) {
    pushDetail(details, `Email to ${recipient}`);
  }

  if (notificationKind) {
    pushDetail(
      details,
      NOTIFICATION_KIND_LABELS[notificationKind] ?? notificationKind,
    );
  }

  const priority = readMetadataString(metadata, "priority");
  const style = readMetadataString(metadata, "style");

  if (priority && style) {
    pushDetail(details, `${priority} priority · ${style} alert`);
  } else if (priority) {
    pushDetail(details, `${priority} priority`);
  }

  const source = readMetadataString(metadata, "source");

  if (source) {
    pushDetail(details, `Source: ${formatMetadataSource(source)}`);
  }

  return details;
}

function getFollowUpDetails(metadata: Record<string, unknown>): string[] {
  const details: string[] = [];
  pushDetail(details, readMetadataString(metadata, "follow_up_notes"));
  return details;
}

function getAppointmentDetails(
  activity: ActivityHistory,
  metadata: Record<string, unknown>,
): string[] {
  const details: string[] = [];
  const appointmentPreference = readMetadataString(
    metadata,
    "appointment_preference",
  );

  if (appointmentPreference) {
    pushDetail(details, `Requested: ${appointmentPreference}`);
  }

  const appointmentAt = readMetadataString(metadata, "appointment_at");

  if (
    appointmentAt &&
    activity.summary !== "Appointment Requested" &&
    !activity.summary.includes(formatLeadAppointmentAt(appointmentAt))
  ) {
    pushDetail(details, formatLeadAppointmentAt(appointmentAt));
  }

  return details;
}

function getCallReceivedDetails(metadata: Record<string, unknown>): string[] {
  const details: string[] = [];
  const event = readMetadataString(metadata, "event");

  if (event && CALL_EVENT_LABELS[event]) {
    pushDetail(details, CALL_EVENT_LABELS[event]);
  }

  const source = readMetadataString(metadata, "source");

  if (source) {
    pushDetail(details, `Source: ${formatMetadataSource(source)}`);
  }

  return details;
}

function getWebsiteLeadCapturedDetails(
  metadata: Record<string, unknown>,
): string[] {
  const details: string[] = [];
  const source = readMetadataString(metadata, "source");

  if (source) {
    pushDetail(details, `Source: ${formatMetadataSource(source)}`);
  }

  const qualificationStatus = readMetadataString(metadata, "qualification_status");

  if (qualificationStatus) {
    pushDetail(details, `Qualification: ${qualificationStatus}`);
  }

  return details;
}

function getStatusChangedDetails(
  activity: ActivityHistory,
  metadata: Record<string, unknown>,
): string[] {
  const details: string[] = [];
  const event = readMetadataString(metadata, "event");
  const restoredStatus = readMetadataString(metadata, "restored_status");
  const previousStatus = readMetadataString(metadata, "previous_status");
  const outcome = readMetadataString(metadata, "outcome");
  const source = readMetadataString(metadata, "source");

  if (event === "lead_restored" && restoredStatus) {
    pushDetail(details, `Restored to ${formatLeadStatus(restoredStatus)}`);
  }

  if (event === "lead_archived" && previousStatus) {
    pushDetail(details, `Previous status: ${formatLeadStatus(previousStatus)}`);
  }

  if (outcome === "lost") {
    const lostReasonLabel =
      readMetadataString(metadata, "lost_reason_label") ??
      formatLostReasonLabel(readMetadataString(metadata, "lost_reason"));
    const lostNotes = readMetadataString(metadata, "lost_notes");

    if (lostReasonLabel && !activity.summary.includes(lostReasonLabel)) {
      pushDetail(details, `Reason: ${lostReasonLabel}`);
    }

    if (lostNotes && !activity.summary.includes(lostNotes)) {
      pushDetail(details, lostNotes);
    }
  }

  if (outcome === "won") {
    const finalJobAmount = readMetadataNumber(metadata, "final_job_amount");

    if (
      finalJobAmount !== null &&
      !activity.summary.includes(formatLeadEstimateAmount(finalJobAmount))
    ) {
      pushDetail(details, `Final job value: ${formatLeadEstimateAmount(finalJobAmount)}`);
    }
  }

  if (source && event !== "lead_archived" && event !== "lead_restored") {
    pushDetail(details, `Updated via ${formatPipelineSource(source)}`);
  }

  return details;
}

function getLeadCreatedDetails(metadata: Record<string, unknown>): string[] {
  const details: string[] = [];
  const source = readMetadataString(metadata, "source");

  if (source) {
    pushDetail(details, `Source: ${formatMetadataSource(source)}`);
  }

  return details;
}

function getEstimateDetails(
  activity: ActivityHistory,
  metadata: Record<string, unknown>,
): string[] {
  const details: string[] = [];
  const estimateAmount = readMetadataNumber(metadata, "estimate_amount");
  const previousEstimateAmount = readMetadataNumber(
    metadata,
    "previous_estimate_amount",
  );
  const source = readMetadataString(metadata, "source");

  if (
    estimateAmount !== null &&
    !activity.summary.includes(formatLeadEstimateAmount(estimateAmount))
  ) {
    pushDetail(details, `Amount: ${formatLeadEstimateAmount(estimateAmount)}`);
  }

  if (
    previousEstimateAmount !== null &&
    estimateAmount !== null &&
    previousEstimateAmount !== estimateAmount &&
    activity.activity_type === "estimate_created"
  ) {
    pushDetail(
      details,
      `Previous amount: ${formatLeadEstimateAmount(previousEstimateAmount)}`,
    );
  }

  if (source) {
    pushDetail(details, `Updated via ${formatPipelineSource(source)}`);
  }

  return details;
}

export function getActivityTimelineDetails(activity: ActivityHistory): string[] {
  const metadata =
    activity.metadata && typeof activity.metadata === "object"
      ? activity.metadata
      : {};

  let details: string[] = [];

  switch (activity.activity_type) {
    case "photo_uploaded":
      details = getPhotoUploadedDetails(metadata);
      break;
    case "notification_queued":
      details = getNotificationQueuedDetails(metadata);
      break;
    case "follow_up_scheduled":
    case "follow_up_rescheduled":
    case "follow_up_completed":
      details = getFollowUpDetails(metadata);
      break;
    case "appointment_booked":
    case "appointment_updated":
      details = getAppointmentDetails(activity, metadata);
      break;
    case "call_received":
      details = getCallReceivedDetails(metadata);
      break;
    case "website_lead_captured":
      details = getWebsiteLeadCapturedDetails(metadata);
      break;
    case "status_changed":
      details = getStatusChangedDetails(activity, metadata);
      break;
    case "lead_created":
      details = getLeadCreatedDetails(metadata);
      break;
    case "estimate_sent":
    case "estimate_created":
      details = getEstimateDetails(activity, metadata);
      break;
    default:
      break;
  }

  return details.slice(0, 2);
}
