"use client";

import { useRouter } from "next/navigation";
import type { Lead } from "@/lib/leads";
import {
  deriveLeadPriority,
  formatLeadAddress,
  formatLeadCallType,
  formatLeadCreatedAt,
  formatLeadStatus,
} from "@/lib/leads";

type LeadListTableProps = {
  leads: Lead[];
};

const priorityStyles: Record<
  ReturnType<typeof deriveLeadPriority>,
  string
> = {
  high: "border-red-900/50 bg-red-950/40 text-red-300",
  medium: "border-yellow-900/50 bg-yellow-950/40 text-yellow-200",
  low: "border-gray-700 bg-gray-900 text-gray-300",
};

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

function PriorityBadge({ lead }: { lead: Lead }) {
  const priority = deriveLeadPriority(lead);

  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${priorityStyles[priority]}`}
    >
      {priority}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[status] ?? "border-gray-700 bg-gray-900 text-gray-300"}`}
    >
      {formatLeadStatus(status)}
    </span>
  );
}

function LeadRow({ lead }: { lead: Lead }) {
  const router = useRouter();
  const href = `/dashboard/leads/${lead.id}`;

  function openLead() {
    router.push(href);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openLead();
    }
  }

  return (
    <tr
      role="link"
      tabIndex={0}
      aria-label={`View lead for ${lead.full_name}`}
      onClick={openLead}
      onKeyDown={handleKeyDown}
      className="cursor-pointer text-sm text-gray-300 transition hover:bg-gray-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
    >
      <td className="px-4 py-4 font-medium text-white sm:px-6">
        {lead.full_name}
      </td>
      <td className="px-4 py-4 sm:px-6">{formatLeadAddress(lead)}</td>
      <td className="px-4 py-4 sm:px-6">{formatLeadCallType(lead)}</td>
      <td className="px-4 py-4 sm:px-6">
        <StatusBadge status={lead.status} />
      </td>
      <td className="px-4 py-4 sm:px-6">
        <PriorityBadge lead={lead} />
      </td>
      <td className="px-4 py-4 text-gray-400 sm:px-6">
        {formatLeadCreatedAt(lead.created_at)}
      </td>
    </tr>
  );
}

export function LeadListTable({ leads }: LeadListTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-950">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-800">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.15em] text-gray-500">
              <th className="px-4 py-4 font-medium sm:px-6">Customer</th>
              <th className="px-4 py-4 font-medium sm:px-6">Property address</th>
              <th className="px-4 py-4 font-medium sm:px-6">Call type</th>
              <th className="px-4 py-4 font-medium sm:px-6">Status</th>
              <th className="px-4 py-4 font-medium sm:px-6">Priority</th>
              <th className="px-4 py-4 font-medium sm:px-6">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
