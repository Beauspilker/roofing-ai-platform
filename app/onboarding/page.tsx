import Link from "next/link";
import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/OnboardingForm";
import { getCompanyByUserId } from "@/lib/companies";
import { createClient } from "@/lib/supabase/server";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/onboarding");
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (company) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <Link
          href="/"
          className="text-sm text-gray-400 transition hover:text-white"
        >
          ← Back to home
        </Link>

        <h1 className="mt-8 text-center text-4xl font-bold">
          Set up your company
        </h1>
        <p className="mt-3 text-center text-gray-400">
          Tell us about your roofing business so we can personalize your
          dashboard.
        </p>

        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950 p-8">
          <OnboardingForm />
        </div>
      </div>
    </main>
  );
}
