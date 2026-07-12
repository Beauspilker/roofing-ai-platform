import { createLead } from "@/app/dashboard/leads/new/actions";
import { LeadForm } from "@/components/leads/LeadForm";

export function CreateLeadForm() {
  return (
    <LeadForm
      action={createLead}
      submitLabel="Save lead"
      pendingLabel="Saving lead..."
      cancelHref="/dashboard"
    />
  );
}
