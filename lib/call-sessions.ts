import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { ROOF_QUESTION } from "@/lib/twilio/helpers";

export const CALL_INTAKE_STAGES = [
  "problem",
  "full_name",
  "address",
  "project_type",
  "insurance_claim",
  "appointment",
] as const;

export type CollectionStage = (typeof CALL_INTAKE_STAGES)[number];

export type ConversationStage = CollectionStage | "wrap_up";

export type TranscriptEntry = {
  role: "caller" | "assistant";
  content: string;
  at: string;
};

export type CollectedFields = {
  stage?: ConversationStage;
  problem_description?: string;
  full_name?: string;
  address?: string;
  project_type?: string;
  insurance_claim?: string;
  appointment_preference?: string;
};

export type CallSession = {
  id: string;
  twilio_call_sid: string;
  company_id: string;
  caller_phone: string | null;
  called_phone: string | null;
  status: string;
  current_question: string | null;
  collected_fields: CollectedFields;
  transcript: TranscriptEntry[];
  attempt_count: number;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

const STAGE_FIELD_KEYS: Record<CollectionStage, keyof CollectedFields> = {
  problem: "problem_description",
  full_name: "full_name",
  address: "address",
  project_type: "project_type",
  insurance_claim: "insurance_claim",
  appointment: "appointment_preference",
};

const STAGE_LABELS: Record<ConversationStage, string> = {
  problem: "what is going on with their roof",
  full_name: "their full name",
  address: "the property address",
  project_type:
    "whether this is a repair, replacement, inspection, or storm damage",
  insurance_claim: "whether they are filing an insurance claim",
  appointment: "when would be a good time for an inspection visit",
  wrap_up: "anything else they need help with before ending the call",
};

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function getCurrentStage(fields: CollectedFields): ConversationStage {
  if (fields.stage) {
    return fields.stage;
  }

  return getNextMissingStage(fields);
}

export function getNextMissingStage(
  fields: CollectedFields,
): ConversationStage {
  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS[stage];
    const value = fields[fieldKey];

    if (typeof value !== "string" || value.trim().length === 0) {
      return stage;
    }
  }

  return "wrap_up";
}

export function applyCallerAnswer(
  fields: CollectedFields,
  stage: ConversationStage,
  answer: string,
): CollectedFields {
  if (stage === "wrap_up") {
    return { ...fields, stage: "wrap_up" };
  }

  const fieldKey = STAGE_FIELD_KEYS[stage];
  const updatedFields: CollectedFields = {
    ...fields,
    [fieldKey]: answer.trim(),
  };

  return {
    ...updatedFields,
    stage: getNextMissingStage(updatedFields),
  };
}

export function formatCollectedFields(fields: CollectedFields): string {
  const lines: string[] = [];

  if (fields.problem_description?.trim()) {
    lines.push(`- Roof issue: ${fields.problem_description.trim()}`);
  }
  if (fields.full_name?.trim()) {
    lines.push(`- Name: ${fields.full_name.trim()}`);
  }
  if (fields.address?.trim()) {
    lines.push(`- Address: ${fields.address.trim()}`);
  }
  if (fields.project_type?.trim()) {
    lines.push(`- Project type: ${fields.project_type.trim()}`);
  }
  if (fields.insurance_claim?.trim()) {
    lines.push(`- Insurance claim: ${fields.insurance_claim.trim()}`);
  }
  if (fields.appointment_preference?.trim()) {
    lines.push(`- Appointment preference: ${fields.appointment_preference.trim()}`);
  }

  return lines.join("\n");
}

export function getStageQuestion(stage: ConversationStage): string | null {
  switch (stage) {
    case "problem":
      return ROOF_QUESTION;
    case "full_name":
      return "May I have your name?";
    case "address":
      return "What is the address of the property?";
    case "project_type":
      return "Is this for a repair, replacement, inspection, or storm damage?";
    case "insurance_claim":
      return "Are you filing an insurance claim for this?";
    case "appointment":
      return "When would be a good time for us to come take a look?";
    default:
      return null;
  }
}

export function createTranscriptEntry(
  role: TranscriptEntry["role"],
  content: string,
): TranscriptEntry {
  return {
    role,
    content,
    at: new Date().toISOString(),
  };
}

export async function getCompanyIdByCalledPhone(
  supabase: SupabaseClient,
  calledPhone: string,
): Promise<string | null> {
  const normalizedCalledPhone = normalizePhone(calledPhone);

  if (!normalizedCalledPhone) {
    return process.env.TWILIO_DEFAULT_COMPANY_ID?.trim() ?? null;
  }

  const { data, error } = await supabase
    .from("companies")
    .select("id, business_phone")
    .not("business_phone", "is", null);

  if (error) {
    throw error;
  }

  for (const company of data ?? []) {
    if (normalizePhone(company.business_phone ?? "") === normalizedCalledPhone) {
      return company.id;
    }
  }

  return process.env.TWILIO_DEFAULT_COMPANY_ID?.trim() ?? null;
}

export async function getCallSessionBySid(
  callSid: string,
): Promise<CallSession | null> {
  const supabase = createServiceClient();

  if (!supabase || !callSid) {
    return null;
  }

  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();

  if (error) {
    console.error("Failed to load call session:", error.message);
    return null;
  }

  return (data as CallSession | null) ?? null;
}

export async function getOrCreateCallSession(input: {
  callSid: string;
  companyId: string;
  callerPhone?: string;
  calledPhone?: string;
}): Promise<CallSession | null> {
  const supabase = createServiceClient();

  if (!supabase || !input.callSid || !input.companyId) {
    return null;
  }

  const { data, error } = await supabase.rpc("get_or_create_call_session", {
    p_twilio_call_sid: input.callSid,
    p_company_id: input.companyId,
    p_caller_phone: input.callerPhone ?? null,
    p_called_phone: input.calledPhone ?? null,
  });

  if (error) {
    console.error("Failed to create call session:", error.message);
    return null;
  }

  return data as CallSession;
}

export async function updateCallSession(input: {
  callSid: string;
  currentQuestion?: string | null;
  collectedFields?: CollectedFields;
  transcriptEntry?: TranscriptEntry;
  attemptCount?: number;
}): Promise<CallSession | null> {
  const supabase = createServiceClient();

  if (!supabase || !input.callSid) {
    return null;
  }

  const { data, error } = await supabase.rpc("update_call_session", {
    p_twilio_call_sid: input.callSid,
    p_current_question: input.currentQuestion ?? null,
    p_collected_fields: input.collectedFields ?? null,
    p_transcript_entry: input.transcriptEntry ?? null,
    p_status: null,
    p_attempt_count: input.attemptCount ?? null,
  });

  if (error) {
    console.error("Failed to update call session:", error.message);
    return null;
  }

  return data as CallSession;
}

export async function completeCallSession(
  callSid: string,
  status: "completed" | "failed" = "completed",
): Promise<CallSession | null> {
  const supabase = createServiceClient();

  if (!supabase || !callSid) {
    return null;
  }

  const { data, error } = await supabase.rpc("complete_call_session", {
    p_twilio_call_sid: callSid,
    p_status: status,
  });

  if (error) {
    console.error("Failed to complete call session:", error.message);
    return null;
  }

  return data as CallSession;
}

export function buildConversationMemoryContext(session: CallSession) {
  const collectedFields =
    (session.collected_fields as CollectedFields | null) ?? {};

  return {
    collectedFields,
    currentStage: getCurrentStage(collectedFields),
    stageLabel: STAGE_LABELS[getCurrentStage(collectedFields)],
    transcript: (session.transcript as TranscriptEntry[] | null) ?? [],
  };
}

export type ConversationMemoryContext = ReturnType<
  typeof buildConversationMemoryContext
>;
