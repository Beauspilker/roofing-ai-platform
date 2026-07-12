import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateLeadForm } from "@/components/leads/CreateLeadForm";
import { getCompanyByUserId } from "@/lib/companies";
import { createClient } from "@/lib/supabase/server";

export default async function NewLeadPage() {
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

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href="/dashboard"
          className="text-sm text-gray-400 transition hover:text-white"
        >
          ← Back to dashboard
        </Link>

        <p className="mt-8 text-sm uppercase tracking-[0.2em] text-blue-400">
          Add lead
        </p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">
          Create a new lead
        </h1>
        <p className="mt-3 text-gray-400">
          Add a customer inquiry manually for {company.company_name}.
        </p>

        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950 p-8">
          <CreateLeadForm />
        </div>
      </div>
    </main>
  );
}
