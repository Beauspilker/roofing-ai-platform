import type { LeadDashboardStats } from "@/lib/leads";

type LeadStatsCardsProps = {
  stats: LeadDashboardStats;
};

const statItems = [
  {
    key: "totalActiveLeads",
    label: "Total active leads",
    description: "Open leads in your pipeline",
  },
  {
    key: "newLeadsToday",
    label: "New leads today",
    description: "Leads created since midnight UTC",
  },
  {
    key: "highPriorityLeads",
    label: "High-priority leads",
    description: "Insurance claims and uncontacted new leads",
  },
  {
    key: "leadsAwaitingContact",
    label: "Leads awaiting contact",
    description: "New leads with no outreach yet",
  },
] as const;

export function LeadStatsCards({ stats }: LeadStatsCardsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {statItems.map((item) => (
        <div
          key={item.key}
          className="rounded-xl border border-gray-800 bg-gray-950 p-5"
        >
          <p className="text-sm text-gray-400">{item.label}</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {stats[item.key]}
          </p>
          <p className="mt-2 text-xs text-gray-500">{item.description}</p>
        </div>
      ))}
    </div>
  );
}
