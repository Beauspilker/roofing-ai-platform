import {
  type CollectedFields,
  formatCollectedFields,
  getNextMissingStage,
  getStageQuestion,
} from "@/lib/call-intake";
import { createServiceClient } from "@/lib/supabase/service";
import {
  normalizePhone,
  resolveCompanyForTwilioCall,
} from "@/lib/twilio/company";

export type {
  CollectedFields,
  CollectionStage,
  ConversationStage,
} from "@/lib/call-intake";
export {
  buildIntakeResponse,
  buildWrapUpSummary,
  formatCollectedFields,
  getNextMissingStage,
  getStageQuestion,
  isIntakeComplete,
  mergeCallerAnswer,
} from "@/lib/call-intake";
export { normalizePhone, resolveCompanyForTwilioCall } from "@/lib/twilio/company";

export type TranscriptEntry = {
  role: "caller" | "assistant";
  content: string;
  at: string;
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

export async function ensureCallSessionForTwilioCall(input: {
  callSid: string;
  callerPhone: string;
  calledPhone: string;
}): Promise<CallSession | null> {
  if (!input.callSid) {
    return null;
  }

  const existingSession = await getCallSessionBySid(input.callSid);

  if (existingSession) {
    return existingSession;
  }

  const companyId = await resolveCompanyForTwilioCall(input.calledPhone);

  if (!companyId) {
    return null;
  }

  return getOrCreateCallSession({
    callSid: input.callSid,
    companyId,
    callerPhone: input.callerPhone,
    calledPhone: input.calledPhone,
  });
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
  const currentStage = getNextMissingStage(collectedFields);

  return {
    collectedFields,
    currentStage,
    transcript: (session.transcript as TranscriptEntry[] | null) ?? [],
  };
}

export type ConversationMemoryContext = ReturnType<
  typeof buildConversationMemoryContext
>;
