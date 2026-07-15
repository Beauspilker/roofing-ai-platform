import {
  completeCallSession,
  getCallSessionBySid,
} from "@/lib/call-sessions";
import { retryCustomerConfirmationSms } from "@/lib/customer-confirmation-sms";
import { retryEmployeeLeadNotification } from "@/lib/employee-lead-notifications";
import { retryPendingCrmLeadCreation } from "@/lib/call-lead-crm";
import { getTwilioCallContext } from "@/lib/twilio/helpers";
import { validateTwilioRequest } from "@/lib/twilio/signature";

export async function POST(request: Request) {
  const formData = await request.formData();

  if (!validateTwilioRequest(request, formData)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { callSid } = getTwilioCallContext(formData);
  const callStatus = formData.get("CallStatus")?.toString().trim() ?? "";

  if (!callSid) {
    return new Response("OK", { status: 200 });
  }

  if (callStatus === "completed" || callStatus === "failed") {
    try {
      await completeCallSession(
        callSid,
        callStatus === "failed" ? "failed" : "completed",
      );

      const session = await getCallSessionBySid(callSid);

      if (
        session &&
        callStatus === "completed" &&
        session.collected_fields?.summary_confirmed === true &&
        !session.lead_id &&
        session.crm_lead_status !== "created"
      ) {
        await retryPendingCrmLeadCreation(callSid);
      }

      const refreshedSession = await getCallSessionBySid(callSid);

      if (
        refreshedSession?.lead_id &&
        refreshedSession.employee_notification_status !== "sent" &&
        refreshedSession.employee_notification_status !== "skipped"
      ) {
        await retryEmployeeLeadNotification(callSid);
      }

      const latestSession = await getCallSessionBySid(callSid);

      if (
        latestSession?.lead_id &&
        latestSession.customer_confirmation_status !== "sent" &&
        latestSession.customer_confirmation_status !== "skipped"
      ) {
        await retryCustomerConfirmationSms(callSid);
      }

      console.info(
        JSON.stringify({
          event: "call_status_update",
          callSid,
          callStatus,
        }),
      );
    } catch (error) {
      console.error("Failed to process call status update:", error);
    }
  }

  return new Response("OK", { status: 200 });
}
