"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  isArchivedLead,
} from "@/lib/leads";
import {
  createSimulatedNotification,
  parseNotificationChannel,
  validateNotificationInput,
} from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";

export type SendCustomerNotificationState = {
  error: string | null;
  success: boolean;
};

export async function sendCustomerNotification(
  _prevState: SendCustomerNotificationState,
  formData: FormData,
): Promise<SendCustomerNotificationState> {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const channelRaw = formData.get("channel")?.toString() ?? "";
  const recipient = formData.get("recipient")?.toString() ?? "";
  const subject = formData.get("subject")?.toString() ?? "";
  const message = formData.get("message")?.toString() ?? "";

  if (!leadId) {
    return { error: "Lead ID is missing.", success: false };
  }

  const channel = parseNotificationChannel(channelRaw);
  const validationError = validateNotificationInput({
    channel,
    recipient,
    subject,
    message,
  });

  if (validationError) {
    return { error: validationError, success: false };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${leadId}`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, leadId, company.id);
  if (!lead) {
    return { error: "Lead not found or you do not have access to it.", success: false };
  }

  if (isArchivedLead(lead)) {
    return {
      error: "Archived leads cannot receive new notifications.",
      success: false,
    };
  }

  try {
    await createSimulatedNotification(supabase, {
      companyId: company.id,
      leadId,
      channel: channel!,
      recipient,
      subject: channel === "email" ? subject : null,
      message,
    });
  } catch (error) {
    if (error instanceof Error) {
      return { error: error.message, success: false };
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        error: formatSupabaseError(
          error as {
            message: string;
            details?: string | null;
            hint?: string | null;
          },
        ),
        success: false,
      };
    }

    return { error: "Failed to queue notification.", success: false };
  }

  const activitySummary =
    channel === "sms"
      ? "SMS notification queued"
      : "Email notification queued";

  try {
    await createActivity(supabase, {
      companyId: company.id,
      leadId,
      activityType: "notification_queued",
      summary: activitySummary,
      actorUserId: user.id,
      metadata: {
        channel,
        recipient: recipient.trim(),
      },
    });
  } catch {
    // Notification is saved even if activity logging fails.
  }

  revalidatePath(`/dashboard/leads/${leadId}`);

  return { error: null, success: true };
}
