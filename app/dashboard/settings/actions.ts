"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createCompanyActivity } from "@/lib/activity";
import {
  getCompanyByUserId,
  updateCompanyProfile,
  formatBusinessControlCenterSchemaError,
  type CompanyProfileUpdate,
} from "@/lib/companies";
import {
  parseBusinessSettingsFormData,
  upsertBusinessSettings,
} from "@/lib/business-settings";
import { formatSupabaseError } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export type BusinessSettingsState = {
  error: string | null;
  success: boolean;
};

export async function saveBusinessControlCenterSettings(
  _prevState: BusinessSettingsState,
  formData: FormData,
): Promise<BusinessSettingsState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/dashboard/settings");
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const companyName = formData.get("company_name")?.toString().trim() ?? "";
  const ownerName = formData.get("owner_name")?.toString().trim() ?? "";

  if (!companyName) {
    return { error: "Company name is required.", success: false };
  }

  if (!ownerName) {
    return { error: "Owner name is required.", success: false };
  }

  const companyUpdate: CompanyProfileUpdate = {
    company_name: companyName,
    owner_name: ownerName,
    business_phone:
      formData.get("business_phone")?.toString().trim() || null,
    business_email:
      formData.get("business_email")?.toString().trim() || null,
    website: formData.get("website")?.toString().trim() || null,
    address_line_1:
      formData.get("address_line_1")?.toString().trim() || null,
    city: formData.get("city")?.toString().trim() || null,
    state: formData.get("state")?.toString().trim() || null,
    postal_code: formData.get("postal_code")?.toString().trim() || null,
    service_area: formData.get("service_area")?.toString().trim() || null,
  };

  const { settings, error: settingsParseError } =
    parseBusinessSettingsFormData(formData);

  if (settingsParseError) {
    return { error: settingsParseError, success: false };
  }

  try {
    await updateCompanyProfile(supabase, company.id, user.id, companyUpdate);
    await upsertBusinessSettings(supabase, company.id, settings);
  } catch (error) {
    if (error instanceof Error) {
      return {
        error: formatBusinessControlCenterSchemaError(error.message),
        success: false,
      };
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        error: formatBusinessControlCenterSchemaError(
          formatSupabaseError(
            error as {
              message: string;
              details?: string | null;
              hint?: string | null;
            },
          ),
        ),
        success: false,
      };
    }

    return { error: "Failed to save business settings.", success: false };
  }

  try {
    await createCompanyActivity(supabase, {
      companyId: company.id,
      activityType: "settings_updated",
      summary: "Business settings updated",
      actorUserId: user.id,
    });
  } catch {
    // Settings save succeeds even if activity logging fails.
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");

  return { error: null, success: true };
}
