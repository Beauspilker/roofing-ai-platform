"use server";

import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import {
  formatSupabaseError,
  parseLeadFormInput,
  type LeadFormState,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export type CreateLeadState = LeadFormState;

export async function createLead(
  _prevState: CreateLeadState,
  formData: FormData,
): Promise<CreateLeadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/dashboard/leads/new");
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const parsed = parseLeadFormInput(formData);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const { data: createdLead, error } = await supabase
    .from("leads")
    .insert({
      company_id: company.id,
      full_name: parsed.full_name,
      phone: parsed.phone ?? null,
      email: parsed.email ?? null,
      address_line_1: parsed.address_line_1 ?? null,
      city: parsed.city ?? null,
      state: parsed.state ?? null,
      postal_code: parsed.postal_code ?? null,
      source: parsed.source,
      status: parsed.status,
      project_type: parsed.project_type ?? null,
      description: parsed.description ?? null,
      insurance_claim: parsed.insurance_claim,
      appointment_at: parsed.appointment_at ?? null,
    })
    .select("id")
    .single();

  if (error) {
    return { error: formatSupabaseError(error) };
  }

  if (!createdLead) {
    return { error: "Failed to create lead." };
  }

  try {
    await createActivity(supabase, {
      companyId: company.id,
      leadId: createdLead.id,
      activityType: "lead_created",
      summary: "Lead created",
      actorUserId: user.id,
    });
  } catch (activityError) {
    if (
      typeof activityError === "object" &&
      activityError !== null &&
      "message" in activityError &&
      typeof activityError.message === "string"
    ) {
      return {
        error: formatSupabaseError(
          activityError as {
            message: string;
            details?: string | null;
            hint?: string | null;
          },
        ),
      };
    }

    return { error: "Lead was created but activity could not be recorded." };
  }

  redirect("/dashboard");
}
