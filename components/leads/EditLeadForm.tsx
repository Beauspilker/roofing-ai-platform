import { updateLead } from "@/app/dashboard/leads/[id]/edit/actions";
import { LeadForm } from "@/components/leads/LeadForm";
import type { Lead } from "@/lib/leads";

type EditLeadFormProps = {
  lead: Lead;
};

export function EditLeadForm({ lead }: EditLeadFormProps) {
  return (
    <LeadForm
      action={updateLead}
      initialLead={lead}
      leadId={lead.id}
      submitLabel="Update lead"
      pendingLabel="Updating lead..."
      cancelHref={`/dashboard/leads/${lead.id}`}
    />
  );
}
