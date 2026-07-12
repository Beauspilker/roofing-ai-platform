"use server";

import { redirect } from "next/navigation";
import { getCompanyByUserId, type CompanyInput } from "@/lib/companies";
import { createClient } from "@/lib/supabase/server";

export type OnboardingState = {
  error: string | null;
};

export async function createCompanyProfile(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const existingCompany = await getCompanyByUserId(supabase, user.id);
  if (existingCompany) {
    redirect("/dashboard");
  }

  const companyName = formData.get("company_name")?.toString().trim() ?? "";
  const ownerName = formData.get("owner_name")?.toString().trim() ?? "";
  const businessPhone = formData.get("business_phone")?.toString().trim() ?? "";
  const businessEmail = formData.get("business_email")?.toString().trim() ?? "";
  const serviceArea = formData.get("service_area")?.toString().trim() ?? "";
  const yearsRaw = formData.get("years_in_business")?.toString().trim() ?? "";

  if (!companyName) {
    return { error: "Company name is required." };
  }

  if (!ownerName) {
    return { error: "Owner name is required." };
  }

  let yearsInBusiness: number | null = null;
  if (yearsRaw) {
    const parsedYears = Number.parseInt(yearsRaw, 10);
    if (Number.isNaN(parsedYears) || parsedYears < 0) {
      return { error: "Years in business must be a valid number." };
    }
    yearsInBusiness = parsedYears;
  }

  const payload: CompanyInput & { user_id: string } = {
    user_id: user.id,
    company_name: companyName,
    owner_name: ownerName,
    business_phone: businessPhone || undefined,
    business_email: businessEmail || undefined,
    service_area: serviceArea || undefined,
    years_in_business: yearsInBusiness,
  };

  const { error } = await supabase.from("companies").insert(payload);

  if (error) {
    return { error: error.message };
  }

  redirect("/dashboard");
}
