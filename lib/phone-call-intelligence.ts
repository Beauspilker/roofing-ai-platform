import type { CollectedFields } from "@/lib/call-intake";
import type { TranscriptEntry } from "@/lib/call-sessions";
import type { Lead } from "@/lib/leads";
import type { SupabaseClient } from "@supabase/supabase-js";

export type IntakeHighlight = {
  label: string;
  value: string;
};

export type TranscriptTurnDisplay = {
  roleLabel: string;
  content: string;
  timeLabel: string | null;
};

export type PhoneCallIntelligence = {
  source: "transcript_record" | "description_fallback";
  aiSummary: string;
  transcript: TranscriptTurnDisplay[];
  highlights: IntakeHighlight[];
  callDate: string | null;
  callDuration: string | null;
  callerPhone: string | null;
  priorityLabel: string | null;
  twilioCallSid: string | null;
  isFallback: boolean;
};

type PhoneCallTranscriptRow = {
  id: string;
  call_session_id: string;
  lead_id: string | null;
  company_id: string;
  twilio_call_sid: string;
  transcript: TranscriptEntry[] | null;
  ai_summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type CallSessionEnrichment = {
  caller_phone: string | null;
  started_at: string | null;
  completed_at: string | null;
  collected_fields: CollectedFields;
};

const INTERNAL_TAG_LINE =
  /^\[(Priority|Source|CallSid|ConversationId):/i;

const APPOINTMENT_LINE = /^Requested appointment:\s*(.+)$/i;

function hasText(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTranscriptEntries(
  value: unknown,
): TranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const role = record.role === "assistant" ? "assistant" : "caller";
    const content =
      typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return [];
    }

    return [
      {
        role,
        content,
        at: typeof record.at === "string" ? record.at : new Date().toISOString(),
      },
    ];
  });
}

function formatCollectedFieldValue(value: string | undefined): string | null {
  if (!hasText(value)) {
    return null;
  }

  const normalized = value.trim();

  if (/^(yes|yeah|yep|true)$/i.test(normalized)) {
    return "Yes";
  }

  if (/^(no|nope|nah|false)$/i.test(normalized)) {
    return "No";
  }

  return normalized;
}

export function stripInternalPhoneLeadTags(description: string): string {
  return description
    .split("\n")
    .filter((line) => !INTERNAL_TAG_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

export function parsePhoneLeadDescriptionFallback(
  description: string | null | undefined,
): {
  summary: string | null;
  appointmentPreference: string | null;
  priorityLabel: string | null;
} {
  if (!hasText(description)) {
    return {
      summary: null,
      appointmentPreference: null,
      priorityLabel: null,
    };
  }

  let appointmentPreference: string | null = null;
  let priorityLabel: string | null = null;
  const summaryLines: string[] = [];

  for (const line of description.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const priorityMatch = trimmed.match(/^\[Priority:\s*(.+)\]$/i);
    if (priorityMatch?.[1]) {
      priorityLabel = priorityMatch[1].trim();
      continue;
    }

    if (INTERNAL_TAG_LINE.test(trimmed)) {
      continue;
    }

    const appointmentMatch = trimmed.match(APPOINTMENT_LINE);
    if (appointmentMatch?.[1]) {
      appointmentPreference = appointmentMatch[1].trim();
      continue;
    }

    summaryLines.push(trimmed);
  }

  const summary = summaryLines.join("\n").trim();

  return {
    summary: summary.length > 0 ? summary : null,
    appointmentPreference,
    priorityLabel,
  };
}

export function formatCallDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string | null {
  if (!hasText(startedAt) || !hasText(completedAt)) {
    return null;
  }

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(completedAt).getTime();

  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return null;
  }

  const totalSeconds = Math.round((endMs - startMs) / 1000);

  if (totalSeconds < 60) {
    return "Less than 1 min";
  }

  const minutes = Math.round(totalSeconds / 60);

  if (minutes === 1) {
    return "1 min";
  }

  return `${minutes} min`;
}

export function formatCallDateTime(value: string | null | undefined): string | null {
  if (!hasText(value)) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatTranscriptRole(role: TranscriptEntry["role"]): string {
  return role === "assistant" ? "Assistant" : "Caller";
}

export function formatTranscriptTurn(entry: TranscriptEntry): TranscriptTurnDisplay {
  const timeLabel = formatCallDateTime(entry.at);

  return {
    roleLabel: formatTranscriptRole(entry.role),
    content: entry.content.trim(),
    timeLabel,
  };
}

export function extractIntakeHighlights(
  fields: CollectedFields | null | undefined,
  appointmentPreference?: string | null,
): IntakeHighlight[] {
  const highlights: IntakeHighlight[] = [];

  const add = (label: string, value: string | null) => {
    if (value) {
      highlights.push({ label, value });
    }
  };

  if (!fields && appointmentPreference) {
    add("Appointment", appointmentPreference);
    return highlights;
  }

  if (!fields) {
    return highlights;
  }

  add("Reason for call", formatCollectedFieldValue(fields.problem_description));
  add("Active leak", formatCollectedFieldValue(fields.active_leak));
  add("Storm damage", formatCollectedFieldValue(fields.storm_damage));
  add("Insurance claim", formatCollectedFieldValue(fields.insurance_claim));
  add("Urgency", formatCollectedFieldValue(fields.urgency));
  add(
    "Appointment",
    formatCollectedFieldValue(fields.appointment_preference) ??
      appointmentPreference ??
      null,
  );
  add("Additional notes", formatCollectedFieldValue(fields.additional_notes));

  return highlights;
}

export function buildPhoneCallIntelligenceViewModel(input: {
  transcriptRow: PhoneCallTranscriptRow;
  session?: CallSessionEnrichment | null;
}): PhoneCallIntelligence {
  const { transcriptRow, session } = input;
  const metadata = transcriptRow.metadata ?? {};
  const collectedFields = session?.collected_fields ?? {};
  const transcriptEntries = normalizeTranscriptEntries(transcriptRow.transcript);
  const priorityFromMetadata =
    typeof metadata.priority_label === "string"
      ? metadata.priority_label.trim()
      : null;
  const priorityLabel =
    priorityFromMetadata ||
    (hasText(collectedFields.priority_label)
      ? collectedFields.priority_label.trim()
      : null);

  const aiSummary =
    transcriptRow.ai_summary?.trim() ||
    collectedFields.crm_summary?.trim() ||
    "Call summary unavailable.";

  const callDate =
    formatCallDateTime(session?.started_at) ??
    formatCallDateTime(transcriptRow.created_at);

  return {
    source: "transcript_record",
    aiSummary,
    transcript: transcriptEntries.map(formatTranscriptTurn),
    highlights: extractIntakeHighlights(collectedFields),
    callDate,
    callDuration: formatCallDuration(session?.started_at, session?.completed_at),
    callerPhone: session?.caller_phone?.trim() || null,
    priorityLabel,
    twilioCallSid: transcriptRow.twilio_call_sid,
    isFallback: false,
  };
}

export function buildPhoneCallIntelligenceFallback(
  lead: Lead,
): PhoneCallIntelligence | null {
  if (lead.source !== "ai_phone") {
    return null;
  }

  const parsed = parsePhoneLeadDescriptionFallback(lead.description);

  if (!parsed.summary && !parsed.appointmentPreference) {
    return null;
  }

  return {
    source: "description_fallback",
    aiSummary: parsed.summary ?? "AI phone lead — summary unavailable.",
    transcript: [],
    highlights: extractIntakeHighlights(null, parsed.appointmentPreference),
    callDate: formatCallDateTime(lead.created_at),
    callDuration: null,
    callerPhone: lead.phone?.trim() || null,
    priorityLabel: parsed.priorityLabel,
    twilioCallSid: null,
    isFallback: true,
  };
}

export function hasCallIntelligenceDisplay(
  intelligence: PhoneCallIntelligence | null,
): intelligence is PhoneCallIntelligence {
  return intelligence !== null;
}

export async function getPhoneCallIntelligenceForLead(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
  lead: Lead,
): Promise<PhoneCallIntelligence | null> {
  const { data: transcriptRow, error: transcriptError } = await supabase
    .from("phone_call_transcripts")
    .select(
      "id, call_session_id, lead_id, company_id, twilio_call_sid, transcript, ai_summary, metadata, created_at",
    )
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (transcriptError) {
    throw transcriptError;
  }

  if (transcriptRow) {
    const { data: sessionRow, error: sessionError } = await supabase
      .from("call_sessions")
      .select("caller_phone, started_at, completed_at, collected_fields")
      .eq("id", transcriptRow.call_session_id)
      .eq("company_id", companyId)
      .maybeSingle();

    if (sessionError) {
      throw sessionError;
    }

    return buildPhoneCallIntelligenceViewModel({
      transcriptRow: {
        ...transcriptRow,
        transcript: normalizeTranscriptEntries(transcriptRow.transcript),
        metadata:
          transcriptRow.metadata && typeof transcriptRow.metadata === "object"
            ? (transcriptRow.metadata as Record<string, unknown>)
            : {},
      },
      session: sessionRow
        ? {
            caller_phone: sessionRow.caller_phone,
            started_at: sessionRow.started_at,
            completed_at: sessionRow.completed_at,
            collected_fields: (sessionRow.collected_fields ??
              {}) as CollectedFields,
          }
        : null,
    });
  }

  return buildPhoneCallIntelligenceFallback(lead);
}
