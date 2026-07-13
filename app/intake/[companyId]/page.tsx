import { notFound } from "next/navigation";
import { IntakeAssistant } from "@/components/intake/IntakeAssistant";
import { getPublicIntakeCompany, isValidCompanyId } from "@/lib/intake";
import { createPublicClient } from "@/lib/supabase/public";

type IntakePageProps = {
  params: Promise<{ companyId: string }>;
};

export default async function IntakePage({ params }: IntakePageProps) {
  const { companyId: rawCompanyId } = await params;
  const companyId = rawCompanyId.trim();

  if (!isValidCompanyId(companyId)) {
    notFound();
  }

  const supabase = createPublicClient();

  let company: Awaited<ReturnType<typeof getPublicIntakeCompany>> = null;

  try {
    company = await getPublicIntakeCompany(supabase, companyId);
  } catch {
    notFound();
  }

  if (!company) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <IntakeAssistant company={company} />
      </div>
    </main>
  );
}
