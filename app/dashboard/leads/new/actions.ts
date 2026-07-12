"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId } from "@/lib/companies";
import {
  isLeadProjectType,
  isLeadSource,
  isLeadStatus,
  type CreateLeadInput,
} from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export type CreateLeadState = {
  error: string | null;
};

function parseCreateLeadInput(formData: FormData): CreateLeadInput | { error: string } {
  const fullName = formData.get("full_name")?.toString().trim() ?? "";
  const source = formData.get("source")?.toString() ?? "manual";
  const status = formData.get("status")?.toString() ?? "new";
  const projectType = formData.get("project_type")?.toString().trim() ?? "";
  const insuranceClaim = formData.get("insurance_claim") === "on";

  if (!fullName) {
    return { error: "Full name is required." };
  }

  if (!isLeadSource(source)) {
    return { error: "Please select a valid source." };
  }

  if (!isLeadStatus(status)) {
    return { error: "Please select a valid status." };
  }

  if (projectType && !isLeadProjectType(projectType)) {
    return { error: "Please select a valid project type." };
  }

  const validatedProjectType = projectType
    ? (projectType as CreateLeadInput["project_type"])
    : undefined;

  return {
    full_name: fullName,
    phone: formData.get("phone")?.toString().trim() || undefined,
    email: formData.get("email")?.toString().trim() || undefined,
    address_line_1:
      formData.get("address_line_1")?.toString().trim() || undefined,
    city: formData.get("city")?.toString().trim() || undefined,
    state: formData.get("state")?.toString().trim() || undefined,
    postal_code: formData.get("postal_code")?.toString().trim() || undefined,
    source,
    status,
    project_type: validatedProjectType,
    description: formData.get("description")?.toString().trim() || undefined,
    insurance_claim: insuranceClaim,
  };
}

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

  const parsed = parseCreateLeadInput(formData);
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
  });

  if (error) {
    return { error: `${error.message}${error.details ? ` (${error.details})` : ""}${error.hint ? ` Hint: ${error.hint}` : ""}` };
  }

  redirect("/dashboard");
}
