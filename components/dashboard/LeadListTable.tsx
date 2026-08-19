"use client";

import { useRouter } from "next/navigation";
import { ArchivedBadge } from "@/components/leads/ArchivedBadge";
import {
  isInspectionOverdue,
  isInspectionUpcoming,
} from "@/lib/lead-inspection-visibility";
import {
  formatLeadListEstimateHint,
  formatLeadListPhone,
  shouldShowEstimateHint,
} from "@/lib/lead-list-display";
import type { Lead } from "@/lib/leads";
import {
  deriveLeadPriority,
  formatLeadAddress,
  formatLeadAppointmentAt,
  formatLeadCreatedAt,
  formatLeadFollowUpAt,
  formatLeadStatus,
  getSourceLabel,
  isArchivedLead,
} from "@/lib/leads";
import { isFollowUpOverdue } from "@/lib/lead-follow-up";

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

function StatusBadge({ lead }: { lead: Lead }) {
  const estimateHint = shouldShowEstimateHint(lead)
    ? formatLeadListEstimateHint(lead)
    : null;

  return (
    <div className="space-y-1">
      <span
        className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[lead.status] ?? "border-gray-700 bg-gray-900 text-gray-300"}`}
      >
        {formatLeadStatus(lead.status)}
      </span>
      {estimateHint ? (
        <p className="text-xs text-gray-400">{estimateHint}</p>
      ) : null}
    </div>
  );
}

function FollowUpBadge({ lead }: { lead: Lead }) {
  if (!lead.follow_up_at) {
    return <span className="text-gray-500">—</span>;
  }

  const overdue = isFollowUpOverdue(lead.follow_up_at);

  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${
        overdue
          ? "border-red-900/50 bg-red-950/40 text-red-300"
          : "border-amber-900/50 bg-amber-950/40 text-amber-200"
      }`}
    >
      {overdue ? "Overdue · " : "Due · "}
      {formatLeadFollowUpAt(lead.follow_up_at)}
    </span>
  );
}

function InspectionBadge({ lead }: { lead: Lead }) {
  if (!lead.appointment_at) {
    return <span className="text-gray-500">—</span>;
  }

  const overdue = isInspectionOverdue(lead.appointment_at);
  const upcoming = isInspectionUpcoming(lead.appointment_at);

  if (!overdue && !upcoming) {
    return <span className="text-gray-500">—</span>;
  }

  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${
        overdue
          ? "border-red-900/50 bg-red-950/40 text-red-300"
          : "border-amber-900/50 bg-amber-950/40 text-amber-200"
      }`}
    >
      {overdue ? "Overdue · " : "Upcoming · "}
      {formatLeadAppointmentAt(lead.appointment_at)}
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
        <div className="flex flex-wrap items-center gap-2">
          <span>{lead.full_name}</span>
          {isArchivedLead(lead) ? <ArchivedBadge /> : null}
        </div>
      </td>
      <td className="px-4 py-4 sm:px-6">{formatLeadListPhone(lead.phone)}</td>
      <td className="px-4 py-4 sm:px-6">{formatLeadAddress(lead)}</td>
      <td className="px-4 py-4 sm:px-6">{getSourceLabel(lead.source)}</td>
      <td className="px-4 py-4 sm:px-6">
        <StatusBadge lead={lead} />
      </td>
      <td className="px-4 py-4 sm:px-6">
        <PriorityBadge lead={lead} />
      </td>
      <td className="px-4 py-4 sm:px-6">
        <InspectionBadge lead={lead} />
      </td>
      <td className="px-4 py-4 sm:px-6">
        <FollowUpBadge lead={lead} />
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
              <th className="px-4 py-4 font-medium sm:px-6">Phone</th>
              <th className="px-4 py-4 font-medium sm:px-6">Property address</th>
              <th className="px-4 py-4 font-medium sm:px-6">Source</th>
              <th className="px-4 py-4 font-medium sm:px-6">Status</th>
              <th className="px-4 py-4 font-medium sm:px-6">Priority</th>
              <th className="px-4 py-4 font-medium sm:px-6">Inspection</th>
              <th className="px-4 py-4 font-medium sm:px-6">Follow-up</th>
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
