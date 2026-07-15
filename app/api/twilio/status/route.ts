import { retryPendingCrmLeadCreation } from "@/lib/call-lead-crm";
import { completeCallSession, getCallSessionBySid } from "@/lib/call-sessions";
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
