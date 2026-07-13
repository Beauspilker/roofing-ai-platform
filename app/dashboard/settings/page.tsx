import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { BusinessControlCenterForm } from "@/components/settings/BusinessControlCenterForm";
import { PublicIntakeLinkSection } from "@/components/settings/PublicIntakeLinkSection";
import { getBusinessSettingsByCompanyId } from "@/lib/business-settings";
import { getCompanyByUserId } from "@/lib/companies";
import { createClient } from "@/lib/supabase/server";

export default async function BusinessSettingsPage() {
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

  const settings = await getBusinessSettingsByCompanyId(supabase, company.id);

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <Link
          href="/dashboard"
          className="text-sm text-gray-400 transition hover:text-white"
        >
          ← Back to dashboard
        </Link>

        <header className="mt-8 flex flex-col gap-6 border-b border-gray-800 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
              Business Control Center
            </p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Settings</h1>
            <p className="mt-3 text-gray-400">
              Manage business profile and automation preferences for{" "}
              {company.company_name}.
            </p>
          </div>

          <SignOutButton />
        </header>

        <div className="mt-8 space-y-8 rounded-xl border border-gray-800 bg-gray-950 p-8">
          <PublicIntakeLinkSection
            companyId={company.id}
            aiPhoneEnabled={settings?.ai_phone_enabled ?? true}
          />
          <BusinessControlCenterForm company={company} settings={settings} />
        </div>
      </div>
    </main>
  );
}
