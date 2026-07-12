import type { Lead } from "@/lib/leads";
import {
  deriveLeadPriority,
  formatInsuranceClaim,
  formatLeadAppointmentAt,
  formatLeadCreatedAt,
  formatLeadFieldValue,
  formatLeadStatus,
  getLeadPriorityLabel,
  getProjectTypeLabel,
  getSourceLabel,
} from "@/lib/leads";

type LeadDetailsViewProps = {
  lead: Lead;
};

const priorityStyles = {
  high: "border-red-900/50 bg-red-950/40 text-red-300",
  medium: "border-yellow-900/50 bg-yellow-950/40 text-yellow-200",
  low: "border-gray-700 bg-gray-900 text-gray-300",
} as const;

const statusStyles: Record<string, string> = {
  new: "border-blue-900/50 bg-blue-950/40 text-blue-200",
  contacted: "border-purple-900/50 bg-purple-950/40 text-purple-200",
  appointment_scheduled:
    "border-indigo-900/50 bg-indigo-950/40 text-indigo-200",
  estimate_sent: "border-cyan-900/50 bg-cyan-950/40 text-cyan-200",
  won: "border-green-900/50 bg-green-950/40 text-green-200",
  lost: "border-gray-700 bg-gray-900 text-gray-400",
  archived: "border-gray-700 bg-gray-900 text-gray-400",
};

function DetailField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-black/40 p-4">
      <dt className="text-xs uppercase tracking-[0.15em] text-gray-500">
        {label}
      </dt>
      <dd className="mt-2 text-sm text-white sm:text-base">{value}</dd>
    </div>
  );
}

export function LeadDetailsView({ lead }: LeadDetailsViewProps) {
  const priority = deriveLeadPriority(lead);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 border-b border-gray-800 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold sm:text-4xl">{lead.full_name}</h1>
          <p className="mt-2 text-sm text-gray-400">
            Created {formatLeadCreatedAt(lead.created_at)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span
            className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${statusStyles[lead.status] ?? "border-gray-700 bg-gray-900 text-gray-300"}`}
          >
            {formatLeadStatus(lead.status)}
          </span>
          <span
            className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium capitalize ${priorityStyles[priority]}`}
          >
            {getLeadPriorityLabel(priority)} priority
          </span>
        </div>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Contact</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <DetailField label="Full name" value={lead.full_name} />
          <DetailField
            label="Phone"
            value={formatLeadFieldValue(lead.phone)}
          />
          <DetailField
            label="Email"
            value={formatLeadFieldValue(lead.email)}
          />
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Property</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <DetailField
            label="Property address"
            value={formatLeadFieldValue(lead.address_line_1)}
          />
          <DetailField label="City" value={formatLeadFieldValue(lead.city)} />
          <DetailField label="State" value={formatLeadFieldValue(lead.state)} />
          <DetailField
            label="Postal code"
            value={formatLeadFieldValue(lead.postal_code)}
          />
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Lead details</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <DetailField
            label="Source"
            value={getSourceLabel(lead.source)}
          />
          <DetailField
            label="Status"
            value={formatLeadStatus(lead.status)}
          />
          <DetailField
            label="Priority"
            value={getLeadPriorityLabel(priority)}
          />
          <DetailField
            label="Project type"
            value={
              lead.project_type
                ? getProjectTypeLabel(lead.project_type)
                : "—"
            }
          />
          <DetailField
            label="Insurance claim"
            value={formatInsuranceClaim(lead.insurance_claim)}
          />
        </dl>

        <DetailField
          label="Description"
          value={formatLeadFieldValue(lead.description)}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Dates</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          {lead.appointment_at ? (
            <DetailField
              label="Appointment date"
              value={formatLeadAppointmentAt(lead.appointment_at)}
            />
          ) : null}
          <DetailField
            label="Created date"
            value={formatLeadCreatedAt(lead.created_at)}
          />
        </dl>
      </section>
    </div>
  );
}
