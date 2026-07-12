import Link from "next/link";
import { redirect } from "next/navigation";
import { LeadListEmptyState } from "@/components/dashboard/LeadListEmptyState";
import { LeadListTable } from "@/components/dashboard/LeadListTable";
import { LeadStatsCards } from "@/components/dashboard/LeadStatsCards";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { getCompanyByUserId } from "@/lib/companies";
import { computeLeadDashboardStats, getLeadsForCompany } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const leads = await getLeadsForCompany(supabase, company.id);
  const stats = computeLeadDashboardStats(leads);

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-6 border-b border-gray-800 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
              Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">
              {company.company_name}
            </h1>
            <p className="mt-2 text-gray-400">
              Welcome back, {company.owner_name}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <SignOutButton />
            <Link
              href="/"
              className="rounded-xl bg-blue-600 px-6 py-3 text-center font-semibold transition hover:bg-blue-700"
            >
              Back to home
            </Link>
          </div>
        </header>

        <LeadStatsCards stats={stats} />

        <section className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Lead list</h2>
              <p className="text-sm text-gray-400">
                Recent customer inquiries for your company
              </p>
            </div>
            <p className="text-sm text-gray-500">
              {leads.length} total lead{leads.length === 1 ? "" : "s"}
            </p>
          </div>

          {leads.length === 0 ? (
            <LeadListEmptyState />
          ) : (
            <LeadListTable leads={leads} />
          )}
        </section>
      </div>
    </main>
  );
}
