"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import { formatSupabaseError, getLeadByIdForCompany } from "@/lib/leads";
import { createNote } from "@/lib/notes";
import { createClient } from "@/lib/supabase/server";

export type AddLeadNoteState = {
  error: string | null;
};

export async function addLeadNote(
  _prevState: AddLeadNoteState,
  formData: FormData,
): Promise<AddLeadNoteState> {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const note = formData.get("note")?.toString() ?? "";

  if (!leadId) {
    return { error: "Lead ID is missing." };
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
    return { error: "Lead not found or you do not have access to it." };
  }

  try {
    await createNote(supabase, {
      leadId,
      companyId: company.id,
      note,
    });

    await createActivity(supabase, {
      companyId: company.id,
      leadId,
      activityType: "note_added",
      summary: "Note added",
      actorUserId: user.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Note cannot be empty.") {
      return { error: error.message };
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        error: formatSupabaseError(
          error as { message: string; details?: string | null; hint?: string | null },
        ),
      };
    }

    return { error: "Failed to save note." };
  }

  revalidatePath(`/dashboard/leads/${leadId}`);

  return { error: null };
}
