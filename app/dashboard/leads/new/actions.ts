"use server";

import { redirect } from "next/navigation";
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

  const { error } = await supabase.from("leads").insert({
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
  });

  if (error) {
    return { error: formatSupabaseError(error) };
  }

  redirect("/dashboard");
}
