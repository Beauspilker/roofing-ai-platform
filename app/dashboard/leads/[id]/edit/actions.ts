"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import {
  formatSupabaseError,
  getLeadByIdForCompany,
  parseLeadFormInput,
  type LeadFormState,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export type UpdateLeadState = LeadFormState;

export async function updateLead(
  _prevState: UpdateLeadState,
  formData: FormData,
): Promise<UpdateLeadState> {
  const leadId = formData.get("lead_id")?.toString() ?? "";

  if (!leadId) {
    return { error: "Lead ID is missing." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${leadId}/edit`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const existingLead = await getLeadByIdForCompany(supabase, leadId, company.id);
  if (!existingLead) {
    return { error: "Lead not found or you do not have access to it." };
  }

  const parsed = parseLeadFormInput(formData);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const { error } = await supabase
    .from("leads")
    .update({
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
    .eq("id", leadId)
    .eq("company_id", company.id);

  if (error) {
    return { error: formatSupabaseError(error) };
  }

  redirect(`/dashboard/leads/${leadId}?saved=1`);
}
