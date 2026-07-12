import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActivityTimelineSection } from "@/components/leads/ActivityTimelineSection";
import { LeadDetailsView } from "@/components/leads/LeadDetailsView";
import { LeadSaveSuccessBanner } from "@/components/leads/LeadSaveSuccessBanner";
import { LeadNotesSection } from "@/components/leads/LeadNotesSection";
import { getActivityByLeadId } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import { getLeadByIdForCompany } from "@/lib/leads";
import { getNotesByLeadId } from "@/lib/notes";
import { createClient } from "@/lib/supabase/server";

type LeadDetailsPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
};

export default async function LeadDetailsPage({
  params,
  searchParams,
}: LeadDetailsPageProps) {
  const { id } = await params;
  const { saved } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${id}`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, id, company.id);
  if (!lead) {
    notFound();
  }

  const notes = await getNotesByLeadId(supabase, lead.id, company.id);
  const activities = await getActivityByLeadId(supabase, lead.id, company.id);

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/dashboard"
            className="inline-flex rounded-xl border border-gray-800 px-5 py-3 text-sm font-semibold text-gray-300 transition hover:border-gray-700 hover:text-white"
          >
            ← Back to Dashboard
          </Link>
          <Link
            href={`/dashboard/leads/${lead.id}/edit`}
            className="inline-flex rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold transition hover:bg-blue-700"
          >
            Edit Lead
          </Link>
        </div>

        {saved === "1" ? (
          <div className="mt-6">
            <LeadSaveSuccessBanner />
          </div>
        ) : null}

        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950 p-6 sm:p-8">
          <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
            Lead details
          </p>
          <div className="mt-6">
            <LeadDetailsView lead={lead} />
            <LeadNotesSection leadId={lead.id} notes={notes} />
            <ActivityTimelineSection activities={activities} />
          </div>
        </div>
      </div>
    </main>
  );
}
