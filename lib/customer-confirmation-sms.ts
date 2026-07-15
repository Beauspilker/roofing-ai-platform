import { createActivity } from "@/lib/activity";
import type { CollectedFields } from "@/lib/call-intake";
import type { CallSession } from "@/lib/call-sessions";
import {
  buildCustomerConfirmationSms,
  isCustomerConfirmationEnabled,
  resolveCustomerPhone,
} from "@/lib/customer-confirmation-content";
import { getBusinessSettingsByCompanyId } from "@/lib/business-settings";
import type { Company } from "@/lib/companies";
import type { Lead } from "@/lib/leads";
import {
  createEmployeeNotificationRecord,
  getEmployeeNotificationForLead,
} from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/service";
import { sendTwilioSms } from "@/lib/twilio/sms-outbound";

export const CUSTOMER_PHONE_AI_CONFIRMATION_KIND =
  "customer_phone_ai_confirmation";

const MAX_CUSTOMER_CONFIRMATION_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 750, 2000];

export type CustomerConfirmationResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "already_sent" }
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

async function recordCustomerConfirmationState(
  callSid: string,
  input: {
    status: "pending" | "sent" | "failed" | "skipped";
    attempts: number;
    error?: string | null;
  },
): Promise<void> {
  const supabase = createServiceClient();

  if (!supabase) {
    return;
  }

  await supabase
    .from("call_sessions")
    .update({
      customer_confirmation_status: input.status,
      customer_confirmation_attempts: input.attempts,
      customer_confirmation_last_error: input.error ?? null,
      ...(input.status === "sent"
        ? { customer_confirmation_sent_at: new Date().toISOString() }
        : {}),
    })
    .eq("twilio_call_sid", callSid);
}

async function logCustomerConfirmationActivity(
  companyId: string,
  leadId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const supabase = createServiceClient();

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
    console.error("Failed to record customer confirmation activity:", error);
  }
}

async function loadCompany(companyId: string): Promise<Company | null> {
  const supabase = createServiceClient();

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
  const supabase = createServiceClient();

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

export async function sendCustomerConfirmationSmsIfNeeded(input: {
  session: CallSession;
  leadId: string;
  fields?: CollectedFields;
}): Promise<CustomerConfirmationResult> {
  const session = input.session;
  const leadId = input.leadId;

  if (!leadId || !session.company_id) {
    return { status: "skipped", reason: "Missing lead or company context." };
  }

  if (session.customer_confirmation_status === "sent") {
    return { status: "already_sent" };
  }

  const supabase = createServiceClient();

  if (!supabase) {
    return {
      status: "failed",
      error: "Supabase service client is not configured.",
      attempts: 0,
    };
  }

  const existing = await getEmployeeNotificationForLead(
    supabase,
    leadId,
    "sms",
    CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
  );

  if (existing && (existing.status === "sent" || existing.status === "simulated")) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "sent",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: null,
    });

    return { status: "already_sent" };
  }

  const company = await loadCompany(session.company_id);

  if (!company) {
    return { status: "skipped", reason: "Company not found." };
  }

  const settings = await getBusinessSettingsByCompanyId(supabase, company.id);

  if (!isCustomerConfirmationEnabled(settings?.sms_follow_up_enabled ?? false)) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: "Customer confirmation SMS is disabled in business settings.",
    });

    return {
      status: "skipped",
      reason: "Customer confirmation SMS is disabled in business settings.",
    };
  }

  const lead = await loadLead(leadId, session.company_id);

  if (!lead) {
    return { status: "skipped", reason: "Lead not found." };
  }

  const fields = input.fields ?? session.collected_fields ?? {};
  const customerPhone = resolveCustomerPhone(
    lead,
    fields,
    session.caller_phone,
  );

  if (!customerPhone) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: "No valid customer phone number available.",
    });

    return {
      status: "skipped",
      reason: "No valid customer phone number available.",
    };
  }

  const message = buildCustomerConfirmationSms({
    lead,
    company,
    fields,
  });

  const startingAttempts = session.customer_confirmation_attempts ?? 0;
  const isRetry = startingAttempts > 0;
  let lastError = "Customer confirmation SMS failed.";

  for (let attempt = 1; attempt <= MAX_CUSTOMER_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 2000;

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const existingNotification = await getEmployeeNotificationForLead(
      supabase,
      leadId,
      "sms",
      CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
    );

    if (
      existingNotification &&
      (existingNotification.status === "sent" ||
        existingNotification.status === "simulated")
    ) {
      await recordCustomerConfirmationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null,
      });

      return { status: "already_sent" };
    }

    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "pending",
      attempts: totalAttempts,
      error: null,
    });

    if (attempt === 1 && !isRetry) {
      await logCustomerConfirmationActivity(
        session.company_id,
        leadId,
        "Customer confirmation queued",
        {
          callSid: redactCallSid(session.twilio_call_sid),
          conversationId: session.id,
          notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
        },
      );
    }

    try {
      const smsResult = await sendTwilioSms(customerPhone, message);
      const status = smsResult.delivered ? "sent" : "simulated";

      if (existingNotification) {
        await supabase
          .from("notifications")
          .update({
            recipient: customerPhone,
            message,
            status,
            sent_at: smsResult.delivered ? new Date().toISOString() : null,
            error_message: smsResult.delivered ? null : smsResult.reason,
          })
          .eq("id", existingNotification.id);
      } else {
        await createEmployeeNotificationRecord(supabase, {
          companyId: session.company_id,
          leadId,
          channel: "sms",
          recipient: customerPhone,
          message,
          notificationKind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
          status,
          sentAt: smsResult.delivered ? new Date().toISOString() : null,
          errorMessage: smsResult.delivered ? null : smsResult.reason,
        });
      }

      await recordCustomerConfirmationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null,
      });

      await logCustomerConfirmationActivity(
        session.company_id,
        leadId,
        isRetry ? "Customer confirmation retry succeeded" : "Customer confirmation sent",
        {
          callSid: redactCallSid(session.twilio_call_sid),
          recipient: redactPhone(customerPhone),
          delivery: status,
          notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
        },
      );

      console.info(
        JSON.stringify({
          event: "customer_confirmation_sent",
          callSid: redactCallSid(session.twilio_call_sid),
          leadId,
          delivery: status,
        }),
      );

      return { status: "sent" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      try {
        if (existingNotification) {
          await supabase
            .from("notifications")
            .update({
              recipient: customerPhone,
              message,
              status: "failed",
              error_message: lastError,
            })
            .eq("id", existingNotification.id);
        } else {
          await createEmployeeNotificationRecord(supabase, {
            companyId: session.company_id,
            leadId,
            channel: "sms",
            recipient: customerPhone,
            message,
            notificationKind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
            status: "failed",
            errorMessage: lastError,
          });
        }
      } catch {
        // Preserve original failure.
      }

      console.error(
        JSON.stringify({
          event: "customer_confirmation_failed",
          callSid: redactCallSid(session.twilio_call_sid),
          leadId,
          attempt: totalAttempts,
          errorMessage: lastError,
        }),
      );
    }
  }

  await recordCustomerConfirmationState(session.twilio_call_sid, {
    status: "failed",
    attempts: startingAttempts + MAX_CUSTOMER_CONFIRMATION_ATTEMPTS,
    error: lastError,
  });

  await logCustomerConfirmationActivity(
    session.company_id,
    leadId,
    "Customer confirmation failed",
    {
      callSid: redactCallSid(session.twilio_call_sid),
      errorMessage: lastError,
      notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
    },
  );

  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_CUSTOMER_CONFIRMATION_ATTEMPTS,
  };
}

export async function retryCustomerConfirmationSms(
  callSid: string,
): Promise<CustomerConfirmationResult> {
  const supabase = createServiceClient();

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

  return sendCustomerConfirmationSmsIfNeeded({
    session,
    leadId: session.lead_id,
  });
}
