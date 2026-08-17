import { createActivity } from "@/lib/activity";
import type { CollectedFields } from "@/lib/call-intake";
import type { CallSession } from "@/lib/call-sessions";
import {
  buildEmployeeLeadNotificationContent,
  buildWebsiteLeadNotificationContent,
  EMPLOYEE_PHONE_AI_LEAD_KIND,
  EMPLOYEE_WEBSITE_LEAD_KIND,
  getLeadDashboardUrl,
  pickEmailRecipient,
  pickSmsRecipient,
  resolveEmployeeNotificationRecipients,
} from "@/lib/employee-lead-notification-content";
import type { IntakeAnswers } from "@/lib/intake";
import type { Company } from "@/lib/companies";
import type { Lead } from "@/lib/leads";
import {
  createEmployeeNotificationRecord,
  getEmployeeNotificationForLead,
  type NotificationChannel,
} from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/service";
import {
  sendResendEmail,
  type SendResendEmailInput,
} from "@/lib/resend/email-outbound";
import { sendTwilioSms } from "@/lib/twilio/sms-outbound";

type EmployeeNotificationRuntime = {
  createClient: typeof createServiceClient;
  sendSms: typeof sendTwilioSms;
  sendEmail: (input: SendResendEmailInput) => ReturnType<typeof sendResendEmail>;
};

let employeeNotificationRuntimeOverride: Partial<EmployeeNotificationRuntime> | null =
  null;

export function __setEmployeeNotificationRuntimeForTests(
  override: Partial<EmployeeNotificationRuntime> | null,
): void {
  employeeNotificationRuntimeOverride = override;
}

function getEmployeeNotificationRuntime(): EmployeeNotificationRuntime {
  return {
    createClient:
      employeeNotificationRuntimeOverride?.createClient ?? createServiceClient,
    sendSms: employeeNotificationRuntimeOverride?.sendSms ?? sendTwilioSms,
    sendEmail:
      employeeNotificationRuntimeOverride?.sendEmail ?? sendResendEmail,
  };
}

const MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 750, 2000];

export type EmployeeNotificationResult =
  | { status: "sent"; channels: NotificationChannel[] }
  | { status: "partial"; channels: NotificationChannel[]; error: string }
  | { status: "skipped"; reason: string }
  | { status: "already_sent"; channels: NotificationChannel[] }
  | { status: "failed"; error: string; attempts: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactCallSid(callSid: string): string {
  if (callSid.length <= 8) {
    return callSid;
  }

  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}

function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length <= 4) {
    return "***";
  }

  return `***${digits.slice(-4)}`;
}

async function recordEmployeeNotificationState(
  callSid: string,
  input: {
    status: "pending" | "sent" | "partial" | "failed" | "skipped";
    attempts: number;
    error?: string | null;
  },
): Promise<void> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase) {
    return;
  }

  await supabase
    .from("call_sessions")
    .update({
      employee_notification_status: input.status,
      employee_notification_attempts: input.attempts,
      employee_notification_last_error: input.error ?? null,
      ...(input.status === "sent" || input.status === "partial"
        ? { employee_notification_sent_at: new Date().toISOString() }
        : {}),
    })
    .eq("twilio_call_sid", callSid);
}

async function logEmployeeActivity(
  companyId: string,
  leadId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase) {
    return;
  }

  try {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "notification_queued",
      summary,
      metadata,
    });
  } catch (error) {
    console.error("Failed to record employee notification activity:", error);
  }
}

async function shouldSkipEmployeeNotification(
  session: CallSession,
): Promise<boolean> {
  return session.employee_notification_status === "sent";
}

async function loadCompany(companyId: string): Promise<Company | null> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as Company | null;
}

async function loadLead(leadId: string, companyId: string): Promise<Lead | null> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as Lead | null;
}

function redactEmail(email: string): string {
  return email.replace(/(.{2}).+(@.+)/, "$1***$2");
}

async function deliverEmployeeEmailNotification(input: {
  supabase: NonNullable<ReturnType<typeof createServiceClient>>;
  companyId: string;
  leadId: string;
  recipient: string;
  subject: string | null;
  message: string;
  isRetry: boolean;
  notificationKind: string;
  existingNotificationId?: string;
}): Promise<{ channel: "email"; ok: boolean; error?: string }> {
  try {
    const emailResult = await getEmployeeNotificationRuntime().sendEmail({
      to: input.recipient,
      subject: input.subject ?? "New Roofing Lead",
      text: input.message,
    });
    const status = emailResult.delivered ? "sent" : "simulated";

    if (input.existingNotificationId) {
      await input.supabase
        .from("notifications")
        .update({
          subject: input.subject,
          message: input.message,
          status,
          sent_at: emailResult.delivered ? new Date().toISOString() : null,
          error_message: emailResult.delivered ? null : emailResult.reason,
        })
        .eq("id", input.existingNotificationId);
    } else {
      await createEmployeeNotificationRecord(input.supabase, {
        companyId: input.companyId,
        leadId: input.leadId,
        channel: "email",
        recipient: input.recipient,
        subject: input.subject,
        message: input.message,
        notificationKind: input.notificationKind,
        status,
        sentAt: emailResult.delivered ? new Date().toISOString() : null,
        errorMessage: emailResult.delivered ? null : emailResult.reason,
      });
    }

    await logEmployeeActivity(
      input.companyId,
      input.leadId,
      input.isRetry
        ? "Employee notification retry succeeded"
        : "Employee email sent",
      {
        channel: "email",
        recipient: redactEmail(input.recipient),
        delivery: status,
        notification_kind: input.notificationKind,
      },
    );

    return { channel: "email", ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (input.existingNotificationId) {
      await input.supabase
        .from("notifications")
        .update({
          status: "failed",
          error_message: message,
        })
        .eq("id", input.existingNotificationId);
    } else {
      try {
        await createEmployeeNotificationRecord(input.supabase, {
          companyId: input.companyId,
          leadId: input.leadId,
          channel: "email",
          recipient: input.recipient,
          subject: input.subject,
          message: input.message,
          notificationKind: input.notificationKind,
          status: "failed",
          errorMessage: message,
        });
      } catch {
        // Preserve original failure.
      }
    }

    return { channel: "email", ok: false, error: message };
  }
}

async function deliverEmployeeChannelNotification(input: {
  companyId: string;
  leadId: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  message: string;
  isRetry: boolean;
  notificationKind: string;
}): Promise<{ channel: NotificationChannel; ok: boolean; error?: string }> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase) {
    return {
      channel: input.channel,
      ok: false,
      error: "Supabase service client is not configured.",
    };
  }

  const existing = await getEmployeeNotificationForLead(
    supabase,
    input.leadId,
    input.channel,
    input.notificationKind,
  );

  if (existing) {
    if (existing.status === "sent" || existing.status === "simulated") {
      return { channel: input.channel, ok: true };
    }

    if (input.channel === "sms") {
      try {
        const smsResult = await getEmployeeNotificationRuntime().sendSms(
          input.recipient,
          input.message,
        );
        const status = smsResult.delivered ? "sent" : "simulated";

        await supabase
          .from("notifications")
          .update({
            message: input.message,
            status,
            sent_at: smsResult.delivered ? new Date().toISOString() : null,
            error_message: smsResult.delivered ? null : smsResult.reason,
          })
          .eq("id", existing.id);

        await logEmployeeActivity(
          input.companyId,
          input.leadId,
          input.isRetry
            ? "Employee notification retry succeeded"
            : "Employee SMS sent",
          {
            channel: "sms",
            recipient: redactPhone(input.recipient),
            delivery: status,
            notification_kind: input.notificationKind,
          },
        );

        return { channel: "sms", ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await supabase
          .from("notifications")
          .update({
            status: "failed",
            error_message: message,
          })
          .eq("id", existing.id);

        return { channel: "sms", ok: false, error: message };
      }
    }

    return deliverEmployeeEmailNotification({
      supabase,
      companyId: input.companyId,
      leadId: input.leadId,
      recipient: input.recipient,
      subject: input.subject,
      message: input.message,
      isRetry: input.isRetry,
      notificationKind: input.notificationKind,
      existingNotificationId: existing.id,
    });
  }

  if (input.channel === "sms") {
    try {
      const smsResult = await getEmployeeNotificationRuntime().sendSms(
        input.recipient,
        input.message,
      );
      const status = smsResult.delivered ? "sent" : "simulated";

      await createEmployeeNotificationRecord(supabase, {
        companyId: input.companyId,
        leadId: input.leadId,
        channel: "sms",
        recipient: input.recipient,
        message: input.message,
        notificationKind: input.notificationKind,
        status,
        sentAt: smsResult.delivered ? new Date().toISOString() : null,
        errorMessage: smsResult.delivered ? null : smsResult.reason,
      });

      await logEmployeeActivity(
        input.companyId,
        input.leadId,
        input.isRetry ? "Employee notification retry succeeded" : "Employee SMS sent",
        {
          channel: "sms",
          recipient: redactPhone(input.recipient),
          delivery: status,
          notification_kind: input.notificationKind,
        },
      );

      return { channel: "sms", ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      try {
        await createEmployeeNotificationRecord(supabase, {
          companyId: input.companyId,
          leadId: input.leadId,
          channel: "sms",
          recipient: input.recipient,
          message: input.message,
          notificationKind: input.notificationKind,
          status: "failed",
          errorMessage: message,
        });
      } catch {
        // Preserve original failure.
      }

      return { channel: "sms", ok: false, error: message };
    }
  }

  return deliverEmployeeEmailNotification({
    supabase,
    companyId: input.companyId,
    leadId: input.leadId,
    recipient: input.recipient,
    subject: input.subject,
    message: input.message,
    isRetry: input.isRetry,
    notificationKind: input.notificationKind,
  });
}

export async function notifyEmployeesOfPhoneAiLead(input: {
  session: CallSession;
  leadId: string;
  fields?: CollectedFields;
}): Promise<EmployeeNotificationResult> {
  const session = input.session;
  const leadId = input.leadId;

  if (!leadId || !session.company_id) {
    return { status: "skipped", reason: "Missing lead or company context." };
  }

  if (await shouldSkipEmployeeNotification(session)) {
    return { status: "already_sent", channels: [] };
  }

  const company = await loadCompany(session.company_id);

  if (!company) {
    return { status: "skipped", reason: "Company not found." };
  }

  const lead = await loadLead(leadId, session.company_id);

  if (!lead) {
    return { status: "skipped", reason: "Lead not found." };
  }

  const fields = input.fields ?? session.collected_fields ?? {};
  const supabase = getEmployeeNotificationRuntime().createClient();
  const recipients = await resolveEmployeeNotificationRecipients(
    company,
    supabase,
  );
  const content = buildEmployeeLeadNotificationContent({
    lead,
    fields,
    callSid: session.twilio_call_sid,
    conversationId: session.id,
    dashboardUrl: getLeadDashboardUrl(leadId),
    companyName: company.company_name,
  });

  const smsRecipient = pickSmsRecipient(recipients, content.style);
  const emailRecipient = pickEmailRecipient(recipients, content.style);

  if (!smsRecipient && !emailRecipient) {
    await recordEmployeeNotificationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.employee_notification_attempts ?? 0,
      error: "No enabled employee notification recipients configured.",
    });

    return {
      status: "skipped",
      reason: "No enabled employee notification recipients configured.",
    };
  }

  const startingAttempts = session.employee_notification_attempts ?? 0;
  const isRetry = startingAttempts > 0;
  let lastError = "Employee notification failed.";

  for (let attempt = 1; attempt <= MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 2000;

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    await recordEmployeeNotificationState(session.twilio_call_sid, {
      status: "pending",
      attempts: totalAttempts,
      error: null,
    });

    if (attempt === 1 && !isRetry) {
      await logEmployeeActivity(session.company_id, leadId, "Employee notification queued", {
        callSid: redactCallSid(session.twilio_call_sid),
        conversationId: session.id,
        priority: content.priorityLabel,
        style: content.style,
        notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND,
      });
    }

    const deliveries = [];
    const errors: string[] = [];

    if (smsRecipient) {
      deliveries.push(
        deliverEmployeeChannelNotification({
          companyId: session.company_id,
          leadId,
          channel: "sms",
          recipient: smsRecipient,
          subject: null,
          message: content.smsBody,
          isRetry,
          notificationKind: EMPLOYEE_PHONE_AI_LEAD_KIND,
        }),
      );
    }

    if (emailRecipient) {
      deliveries.push(
        deliverEmployeeChannelNotification({
          companyId: session.company_id,
          leadId,
          channel: "email",
          recipient: emailRecipient,
          subject: content.emailSubject,
          message: content.emailBody,
          isRetry,
          notificationKind: EMPLOYEE_PHONE_AI_LEAD_KIND,
        }),
      );
    }

    const results = await Promise.all(deliveries);
    const successfulChannels = results.filter((result) => result.ok).map((r) => r.channel);
    const failed = results.filter((result) => !result.ok);

    if (failed.length === 0) {
      await recordEmployeeNotificationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null,
      });

      console.info(
        JSON.stringify({
          event: "employee_notification_sent",
          callSid: redactCallSid(session.twilio_call_sid),
          leadId,
          channels: successfulChannels,
          style: content.style,
        }),
      );

      return { status: "sent", channels: successfulChannels };
    }

    if (successfulChannels.length > 0) {
      lastError = failed.map((item) => item.error).filter(Boolean).join("; ");

      await recordEmployeeNotificationState(session.twilio_call_sid, {
        status: "partial",
        attempts: totalAttempts,
        error: lastError,
      });

      await logEmployeeActivity(
        session.company_id,
        leadId,
        "Employee notification failed",
        {
          callSid: redactCallSid(session.twilio_call_sid),
          failed_channels: failed.map((item) => item.channel),
          notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND,
        },
      );

      return {
        status: "partial",
        channels: successfulChannels,
        error: lastError,
      };
    }

    lastError =
      failed.map((item) => item.error).filter(Boolean).join("; ") ||
      "Employee notification failed.";

    console.error(
      JSON.stringify({
        event: "employee_notification_failed",
        callSid: redactCallSid(session.twilio_call_sid),
        leadId,
        attempt: totalAttempts,
        errorMessage: lastError,
      }),
    );
  }

  await recordEmployeeNotificationState(session.twilio_call_sid, {
    status: "failed",
    attempts: startingAttempts + MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS,
    error: lastError,
  });

  await logEmployeeActivity(session.company_id, leadId, "Employee notification failed", {
    callSid: redactCallSid(session.twilio_call_sid),
    errorMessage: lastError,
    notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND,
  });

  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS,
  };
}

export async function notifyEmployeesOfPhoneAiLeadIfNeeded(input: {
  session: CallSession;
  leadId: string;
}): Promise<EmployeeNotificationResult> {
  if (
    input.session.employee_notification_status === "sent" ||
    input.session.employee_notification_status === "skipped"
  ) {
    return { status: "already_sent", channels: [] };
  }

  return notifyEmployeesOfPhoneAiLead(input);
}

export async function retryEmployeeLeadNotification(
  callSid: string,
): Promise<EmployeeNotificationResult> {
  const supabase = getEmployeeNotificationRuntime().createClient();

  if (!supabase || !callSid) {
    return {
      status: "failed",
      error: "Supabase service client is not configured.",
      attempts: 0,
    };
  }

  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();

  if (error || !data) {
    return {
      status: "failed",
      error: error?.message ?? "Call session not found.",
      attempts: 0,
    };
  }

  const session = data as CallSession;

  if (!session.lead_id) {
    return { status: "skipped", reason: "No CRM lead linked to this call." };
  }

  return notifyEmployeesOfPhoneAiLead({
    session,
    leadId: session.lead_id,
  });
}

export async function notifyEmployeesOfWebsiteLead(input: {
  companyId: string;
  leadId: string;
  answers: IntakeAnswers;
}): Promise<EmployeeNotificationResult> {
  const { companyId, leadId } = input;

  if (!leadId || !companyId) {
    return { status: "skipped", reason: "Missing lead or company context." };
  }

  const company = await loadCompany(companyId);

  if (!company) {
    return { status: "skipped", reason: "Company not found." };
  }

  const lead = await loadLead(leadId, companyId);

  if (!lead) {
    return { status: "skipped", reason: "Lead not found." };
  }

  const supabase = getEmployeeNotificationRuntime().createClient();
  const recipients = await resolveEmployeeNotificationRecipients(
    company,
    supabase,
  );
  const content = buildWebsiteLeadNotificationContent({
    lead,
    answers: input.answers,
    dashboardUrl: getLeadDashboardUrl(leadId),
    companyName: company.company_name,
  });

  const smsRecipient = pickSmsRecipient(recipients, content.style);
  const emailRecipient = pickEmailRecipient(recipients, content.style);

  if (!smsRecipient && !emailRecipient) {
    return {
      status: "skipped",
      reason: "No enabled employee notification recipients configured.",
    };
  }

  await logEmployeeActivity(companyId, leadId, "Employee notification queued", {
    priority: content.priorityLabel,
    style: content.style,
    notification_kind: EMPLOYEE_WEBSITE_LEAD_KIND,
    source: "website",
  });

  const deliveries = [];
  const errors: string[] = [];

  if (smsRecipient) {
    deliveries.push(
      deliverEmployeeChannelNotification({
        companyId,
        leadId,
        channel: "sms",
        recipient: smsRecipient,
        subject: null,
        message: content.smsBody,
        isRetry: false,
        notificationKind: EMPLOYEE_WEBSITE_LEAD_KIND,
      }),
    );
  }

  if (emailRecipient) {
    deliveries.push(
      deliverEmployeeChannelNotification({
        companyId,
        leadId,
        channel: "email",
        recipient: emailRecipient,
        subject: content.emailSubject,
        message: content.emailBody,
        isRetry: false,
        notificationKind: EMPLOYEE_WEBSITE_LEAD_KIND,
      }),
    );
  }

  const results = await Promise.all(deliveries);
  const successfulChannels = results.filter((result) => result.ok).map((r) => r.channel);
  const failed = results.filter((result) => !result.ok);

  if (failed.length === 0) {
    console.info(
      JSON.stringify({
        event: "employee_website_notification_sent",
        leadId,
        channels: successfulChannels,
        style: content.style,
      }),
    );

    return { status: "sent", channels: successfulChannels };
  }

  if (successfulChannels.length > 0) {
    const lastError = failed.map((item) => item.error).filter(Boolean).join("; ");

    await logEmployeeActivity(companyId, leadId, "Employee notification failed", {
      failed_channels: failed.map((item) => item.channel),
      notification_kind: EMPLOYEE_WEBSITE_LEAD_KIND,
      source: "website",
    });

    return {
      status: "partial",
      channels: successfulChannels,
      error: lastError,
    };
  }

  const lastError =
    failed.map((item) => item.error).filter(Boolean).join("; ") ||
    "Employee notification failed.";

  await logEmployeeActivity(companyId, leadId, "Employee notification failed", {
    errorMessage: lastError,
    notification_kind: EMPLOYEE_WEBSITE_LEAD_KIND,
    source: "website",
  });

  console.error(
    JSON.stringify({
      event: "employee_website_notification_failed",
      leadId,
      errorMessage: lastError,
    }),
  );

  return {
    status: "failed",
    error: lastError,
    attempts: 1,
  };
}
