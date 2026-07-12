import type { SupabaseClient } from "@supabase/supabase-js";

export type LeadNote = {
  id: string;
  lead_id: string;
  company_id: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export function formatNoteCreatedDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

export function formatNoteCreatedTime(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

export async function getNotesByLeadId(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<LeadNote[]> {
  const { data, error } = await supabase
    .from("lead_notes")
    .select("*")
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function createNote(
  supabase: SupabaseClient,
  {
    leadId,
    companyId,
    note,
  }: {
    leadId: string;
    companyId: string;
    note: string;
  },
): Promise<LeadNote> {
  const trimmedNote = note.trim();

  if (!trimmedNote) {
    throw new Error("Note cannot be empty.");
  }

  const { data, error } = await supabase
    .from("lead_notes")
    .insert({
      lead_id: leadId,
      company_id: companyId,
      note: trimmedNote,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Failed to create note.");
  }

  return data;
}
