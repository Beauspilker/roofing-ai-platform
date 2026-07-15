import type { CollectedFields } from "@/lib/call-intake";
import { buildCrmCallSummary } from "@/lib/call-summary";
import {
  type CallSession,
  type TranscriptEntry,
  getCallSessionBySid,
  updateCallSession,
} from "@/lib/call-sessions";
import type { ActivityType } from "@/lib/activity";
import type { LeadProjectType } from "@/lib/leads";
import {
  notifyEmployeesOfPhoneAiLeadIfNeeded,
} from "@/lib/employee-lead-notifications";
import { createServiceClient } from "@/lib/supabase/service";

export type PhoneLeadPriorityLabel = "Emergency" | "High" | "Medium" | "Low";

export type CrmLeadCreationResult =
  | { status: "created"; leadId: string }
  | { status: "skipped"; reason: string }
  | { status: "already_created"; leadId: string }
  | { status: "failed"; error: string; attempts: number };

const MAX_CRM_LEAD_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 500, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAffirmative(value: string | undefined): boolean {
  return (
    hasText(value) &&
    /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim())
  );
}

export function shouldCreateCrmLeadFromSession(session: CallSession): boolean {
  if (session.status !== "completed") {
    return false;
  }

  if (session.lead_id) {
    return false;
  }

  const fields = session.collected_fields ?? {};

  return fields.summary_confirmed === true;
}

export function derivePhoneLeadPriorityLabel(
  fields: CollectedFields,
): PhoneLeadPriorityLabel {
  const urgency = fields.urgency?.toLowerCase() ?? "";

  if (
    fields.emergency_acknowledged === true ||
    urgency.includes("emergency") ||
    urgency.includes("asap")
  ) {
    return "Emergency";
  }

  if (
    isAffirmative(fields.active_leak) ||
    urgency.includes("urgent") ||
    urgency.includes("today") ||
    urgency.includes("right away")
  ) {
    return "High";
  }

  if (
    isAffirmative(fields.storm_damage) ||
    fields.project_type?.toLowerCase().includes("storm") ||
    isAffirmative(fields.insurance_claim)
  ) {
    return "Medium";
  }

  return "Low";
}

export function mapCallProjectType(
  value: string | undefined,
): LeadProjectType | null {
  if (!hasText(value)) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized.includes("storm")) {
    return "storm_damage";
  }

  if (normalized.includes("repair")) {
    return "repair";
  }

  if (normalized.includes("replace")) {
    return "replacement";
  }

  if (normalized.includes("inspect")) {
    return "inspection";
  }

  if (
    normalized === "repair" ||
    normalized === "replacement" ||
    normalized === "inspection" ||
    normalized === "storm_damage" ||
    normalized === "other"
  ) {
    return normalized as LeadProjectType;
  }

  return "other";
}

export function parseCallInsuranceClaim(value: string | undefined): boolean {
  if (!hasText(value)) {
    return false;
  }

  return isAffirmative(value);
}

export function buildPhoneLeadDescription(
  session: CallSession,
  fields: CollectedFields,
): string {
  const summary = buildCrmCallSummary(fields);
  const priorityLabel = derivePhoneLeadPriorityLabel(fields);
  const lines = [summary];

  if (hasText(fields.appointment_preference)) {
    lines.push(`Requested appointment: ${fields.appointment_preference.trim()}`);
  }

  lines.push(
    `[Priority: ${priorityLabel}]`,
    "[Source: Phone AI]",
    `[CallSid: ${session.twilio_call_sid}]`,
    `[ConversationId: ${session.id}]`,
  );

  return lines.filter(Boolean).join("\n");
}

export function prepareCallSessionFieldsForCrm(
  session: CallSession,
): CollectedFields {
  const fields = { ...(session.collected_fields ?? {}) };
  const priorityLabel = derivePhoneLeadPriorityLabel(fields);

  return {
    ...fields,
    priority_label: priorityLabel,
    crm_summary: buildCrmCallSummary(fields),
  };
}

function redactCallSid(callSid: string): string {
  if (callSid.length <= 8) {
    return callSid;
  }

  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}

async function recordCrmLeadAttempt(
  callSid: string,
  input: {
    status: "pending" | "created" | "failed" | "skipped";
    attempts: number;
    error?: string | null;
    leadId?: string | null;
  },
): Promise<void> {
  const supabase = createServiceClient();

  if (!supabase) {
    return;
  }

  await supabase
    .from("call_sessions")
    .update({
      crm_lead_status: input.status,
      crm_lead_attempts: input.attempts,
      crm_lead_last_error: input.error ?? null,
      ...(input.leadId
        ? {
            lead_id: input.leadId,
            crm_lead_created_at: new Date().toISOString(),
          }
        : {}),
    })
    .eq("twilio_call_sid", callSid);
}

async function createLeadViaRpc(callSid: string): Promise<string | null> {
  const supabase = createServiceClient();

  if (!supabase) {
    throw new Error("Supabase service client is not configured.");
  }

  const { data, error } = await supabase.rpc(
    "create_phone_ai_lead_from_call_session",
    {
      p_twilio_call_sid: callSid,
    },
  );

  if (error) {
    throw error;
  }

  return (data as string | null) ?? null;
}

async function createLeadViaDirectInsert(
  session: CallSession,
): Promise<string> {
  const supabase = createServiceClient();

  if (!supabase) {
    throw new Error("Supabase service client is not configured.");
  }

  const fields = prepareCallSessionFieldsForCrm(session);
  const description = buildPhoneLeadDescription(session, fields);
  const fullName = fields.full_name?.trim() || "Unknown caller";
  const phone =
    fields.callback_phone?.trim() || session.caller_phone?.trim() || null;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      company_id: session.company_id,
      full_name: fullName,
      phone,
      email: null,
      address_line_1: fields.address?.trim() || null,
      city: null,
      state: null,
      postal_code: null,
      source: "ai_phone",
      status: "new",
      project_type: mapCallProjectType(fields.project_type),
      description,
      insurance_claim: parseCallInsuranceClaim(fields.insurance_claim),
      appointment_at: null,
    })
    .select("id")
    .single();

  if (leadError || !lead) {
    throw leadError ?? new Error("Lead insert returned no data.");
  }

  const transcript = (session.transcript as TranscriptEntry[]) ?? [];

  const { error: transcriptError } = await supabase
    .from("phone_call_transcripts")
    .upsert(
      {
        call_session_id: session.id,
        lead_id: lead.id,
        company_id: session.company_id,
        twilio_call_sid: session.twilio_call_sid,
        transcript,
        ai_summary: fields.crm_summary ?? buildCrmCallSummary(fields),
        metadata: {
          priority_label: fields.priority_label,
          conversation_id: session.id,
          source: "Phone AI",
        },
      },
      { onConflict: "call_session_id" },
    );

  if (transcriptError) {
    console.error("Failed to store phone call transcript:", transcriptError.message);
  }

  const activityRows: Array<{
    company_id: string;
    lead_id: string;
    activity_type: ActivityType;
    summary: string;
    metadata: Record<string, unknown>;
  }> = [
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Incoming AI Phone Call",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        source: "Phone AI",
      },
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "lead_created",
      summary: "Lead Created",
      metadata: {
        source: "ai_phone",
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
      },
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Summary Generated",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        event: "summary_generated",
      },
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Customer Confirmed",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        event: "customer_confirmed",
      },
    },
  ];

  if (hasText(fields.appointment_preference)) {
    activityRows.push({
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "appointment_booked",
      summary: "Appointment Requested",
      metadata: {
        appointment_preference: fields.appointment_preference.trim(),
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
      },
    });
  }

  const { error: activityError } = await supabase
    .from("activity_history")
    .insert(activityRows);

  if (activityError) {
    console.error("Failed to create lead activities:", activityError.message);
  }

  await supabase
    .from("call_sessions")
    .update({
      lead_id: lead.id,
      crm_lead_status: "created",
      crm_lead_created_at: new Date().toISOString(),
      crm_lead_last_error: null,
    })
    .eq("twilio_call_sid", session.twilio_call_sid);

  return lead.id;
}

export async function createCrmLeadFromCallSession(
  session: CallSession,
): Promise<CrmLeadCreationResult> {
  if (!shouldCreateCrmLeadFromSession(session)) {
    await recordCrmLeadAttempt(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.crm_lead_attempts ?? 0,
    });

    return {
      status: "skipped",
      reason: "Call was not confirmed or is not eligible for CRM lead creation.",
    };
  }

  if (session.lead_id) {
    try {
      await notifyEmployeesOfPhoneAiLeadIfNeeded({
        session,
        leadId: session.lead_id,
      });
    } catch (notificationError) {
      console.error("Employee notification after existing lead failed:", notificationError);
    }

    return { status: "already_created", leadId: session.lead_id };
  }

  const preparedFields = prepareCallSessionFieldsForCrm(session);
  const preparedSession: CallSession = {
    ...session,
    collected_fields: preparedFields,
  };

  await updateCallSession({
    callSid: session.twilio_call_sid,
    collectedFields: preparedFields,
  });

  let lastError = "Unknown CRM lead creation error.";
  const startingAttempts = session.crm_lead_attempts ?? 0;

  for (let attempt = 1; attempt <= MAX_CRM_LEAD_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 1500;

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await recordCrmLeadAttempt(session.twilio_call_sid, {
        status: "pending",
        attempts: totalAttempts,
        error: null,
      });

      let leadId: string | null = null;

      try {
        leadId = await createLeadViaRpc(session.twilio_call_sid);
      } catch (rpcError) {
        const message =
          rpcError instanceof Error ? rpcError.message : String(rpcError);

        if (message.includes("Could not find the function")) {
          leadId = await createLeadViaDirectInsert(preparedSession);
        } else {
          throw rpcError;
        }
      }

      if (!leadId) {
        return {
          status: "skipped",
          reason: "CRM lead creation skipped by database rules.",
        };
      }

      console.info(
        JSON.stringify({
          event: "crm_lead_created",
          callSid: redactCallSid(session.twilio_call_sid),
          leadId,
          attempts: totalAttempts,
        }),
      );

      try {
        const refreshedSession = await getCallSessionBySid(session.twilio_call_sid);
        await notifyEmployeesOfPhoneAiLeadIfNeeded({
          session: refreshedSession ?? { ...session, lead_id: leadId },
          leadId,
        });
      } catch (notificationError) {
        console.error("Employee notification after CRM lead creation failed:", notificationError);
      }

      return { status: "created", leadId };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      console.error(
        JSON.stringify({
          event: "crm_lead_creation_failed",
          callSid: redactCallSid(session.twilio_call_sid),
          attempt: totalAttempts,
          errorMessage: lastError,
        }),
      );

      await recordCrmLeadAttempt(session.twilio_call_sid, {
        status: "failed",
        attempts: totalAttempts,
        error: lastError,
      });
    }
  }

  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_CRM_LEAD_ATTEMPTS,
  };
}

export async function createCrmLeadFromCallSid(
  callSid: string,
): Promise<CrmLeadCreationResult> {
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

  return createCrmLeadFromCallSession(data as CallSession);
}

export async function retryPendingCrmLeadCreation(
  callSid: string,
): Promise<CrmLeadCreationResult> {
  return createCrmLeadFromCallSid(callSid);
}
