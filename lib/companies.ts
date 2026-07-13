import type { SupabaseClient } from "@supabase/supabase-js";

export type Company = {
  id: string;
  user_id: string;
  company_name: string;
  owner_name: string;
  business_phone: string | null;
  business_email: string | null;
  website: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  service_area: string | null;
  years_in_business: number | null;
  created_at: string;
  updated_at: string;
};

export type CompanyInput = {
  company_name: string;
  owner_name: string;
  business_phone?: string;
  business_email?: string;
  service_area?: string;
  years_in_business?: number | null;
};

export type CompanyProfileUpdate = {
  company_name: string;
  owner_name: string;
  business_phone?: string | null;
  business_email?: string | null;
  website?: string | null;
  address_line_1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  service_area?: string | null;
};

const COMPANY_SELECT_COLUMNS =
  "id, user_id, company_name, owner_name, business_phone, business_email, website, address_line_1, city, state, postal_code, service_area, years_in_business, created_at, updated_at";

function isMissingColumnError(message: string): boolean {
  return (
    message.includes("schema cache") ||
    message.includes("Could not find the") ||
    message.includes("column of 'companies'") ||
    message.includes("column of 'business_settings'")
  );
}

export function formatBusinessControlCenterSchemaError(message: string): string {
  if (isMissingColumnError(message)) {
    return (
      "Database schema is out of date. Run supabase/phase_10_business_control_center.sql " +
      "in the Supabase SQL Editor, then try saving again."
    );
  }

  return message;
}

export async function getCompanyByUserId(
  supabase: SupabaseClient,
  userId: string,
): Promise<Company | null> {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateCompanyProfile(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CompanyProfileUpdate,
): Promise<Company> {
  const { data, error } = await supabase
    .from("companies")
    .update({
      company_name: input.company_name,
      owner_name: input.owner_name,
      business_phone: input.business_phone ?? null,
      business_email: input.business_email ?? null,
      website: input.website ?? null,
      address_line_1: input.address_line_1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postal_code: input.postal_code ?? null,
      service_area: input.service_area ?? null,
    })
    .eq("id", companyId)
    .eq("user_id", userId)
    .select(COMPANY_SELECT_COLUMNS)
    .single();

  if (error) {
    throw new Error(formatBusinessControlCenterSchemaError(error.message));
  }

  if (!data) {
    throw new Error("Failed to update company profile.");
  }

  return data as Company;
}
