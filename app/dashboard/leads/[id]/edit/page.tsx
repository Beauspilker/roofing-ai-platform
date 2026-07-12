import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EditLeadForm } from "@/components/leads/EditLeadForm";
import { getCompanyByUserId } from "@/lib/companies";
import { getLeadByIdForCompany } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

type EditLeadPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditLeadPage({ params }: EditLeadPageProps) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${id}/edit`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, id, company.id);
  if (!lead) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href={`/dashboard/leads/${lead.id}`}
          className="text-sm text-gray-400 transition hover:text-white"
        >
          ← Back to lead details
        </Link>

        <p className="mt-8 text-sm uppercase tracking-[0.2em] text-blue-400">
          Edit lead
        </p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">
          Update {lead.full_name}
        </h1>
        <p className="mt-3 text-gray-400">
          Make changes to this lead for {company.company_name}.
        </p>

        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950 p-8">
          <EditLeadForm lead={lead} />
        </div>
      </div>
    </main>
  );
}
