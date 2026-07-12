import type { SupabaseClient } from "@supabase/supabase-js";

export type Company = {
  id: string;
  user_id: string;
  company_name: string;
  owner_name: string;
  business_phone: string | null;
  business_email: string | null;
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
