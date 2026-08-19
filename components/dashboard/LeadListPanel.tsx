"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LeadListTable } from "@/components/dashboard/LeadListTable";
import {
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  formatLeadStatus,
  getLeadPriorityLabel,
  getProjectTypeLabel,
  getSourceLabel,
  isArchivedLead,
  isDashboardActiveLead,
  isLeadAttentionFilter,
  isLeadFollowUpFilter,
  isLeadInspectionFilter,
  isLeadStatus,
  LEAD_PRIORITIES,
  LEAD_PROJECT_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type Lead,
  type LeadArchiveView,
  type LeadFilterValues,
  type LeadFollowUpFilter,
  type LeadInspectionFilter,
  type LeadPriority,
  type LeadProjectType,
  type LeadSource,
  type LeadStatus,
} from "@/lib/leads";

type LeadListPanelProps = {
  leads: Lead[];
};

const inputClassName =
  "w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600";

const FOLLOW_UP_FILTER_OPTIONS: { value: LeadFollowUpFilter; label: string }[] = [
  { value: "all", label: "All follow-ups" },
  { value: "due", label: "Follow-ups due" },
  { value: "overdue", label: "Overdue follow-ups" },
  { value: "none", label: "No follow-up scheduled" },
];

const INSPECTION_FILTER_OPTIONS: {
  value: LeadInspectionFilter;
  label: string;
}[] = [
  { value: "all", label: "All inspections" },
  { value: "upcoming", label: "Upcoming inspections" },
  { value: "overdue", label: "Overdue inspections" },
  { value: "none", label: "No inspection scheduled" },
];

function LeadListPanelContent({ leads }: LeadListPanelProps) {
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<LeadFilterValues>(DEFAULT_LEAD_FILTERS);

  useEffect(() => {
    const status = searchParams.get("status");
    const followUp = searchParams.get("followUp");
    const inspection = searchParams.get("inspection");
    const attention = searchParams.get("attention");

    setFilters((current) => {
      let next = current;

      if (status && isLeadStatus(status)) {
        next = {
          ...next,
          status,
          archiveView: "active",
        };
      }

      if (followUp && isLeadFollowUpFilter(followUp)) {
        next = {
          ...next,
          followUp,
          archiveView: "active",
        };
      }

      if (inspection && isLeadInspectionFilter(inspection)) {
        next = {
          ...next,
          inspection,
          archiveView: "active",
        };
      }

      if (attention && isLeadAttentionFilter(attention)) {
        next = {
          ...next,
          attention,
          archiveView: "active",
        };
      }

      return next;
    });
  }, [searchParams]);

  const filteredLeads = useMemo(
    () => filterLeads(leads, filters),
    [leads, filters],
  );

  const visiblePoolCount = useMemo(() => {
    if (filters.archiveView === "all") {
      return leads.length;
    }

    if (filters.archiveView === "archived") {
      return leads.filter(isArchivedLead).length;
    }

    return leads.filter(isDashboardActiveLead).length;
  }, [filters.archiveView, leads]);

  const hasActiveFilters =
    filters.search.trim().length > 0 ||
    filters.status !== "all" ||
    filters.priority !== "all" ||
    filters.projectType !== "all" ||
    filters.source !== "all" ||
    filters.followUp !== "all" ||
    filters.inspection !== "all" ||
    filters.attention !== "all" ||
    filters.archiveView !== "active";

  function updateFilter<K extends keyof LeadFilterValues>(
    key: K,
    value: LeadFilterValues[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 sm:p-5">
        <label htmlFor="lead-search" className="block text-sm font-medium text-gray-300">
          Search leads
        </label>
        <input
          id="lead-search"
          type="search"
          value={filters.search}
          onChange={(event) => updateFilter("search", event.target.value)}
          placeholder="Search by name, phone, email, city, or address..."
          className={`${inputClassName} mt-2`}
        />

        <div className="mt-4">
          <FilterSelect
            id="filter-archive-view"
            label="Show"
            value={filters.archiveView}
            onChange={(value) =>
              updateFilter("archiveView", value as LeadArchiveView)
            }
            options={[
              { value: "active", label: "Active leads" },
              { value: "archived", label: "Archived leads" },
              { value: "all", label: "All leads" },
            ]}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <FilterSelect
            id="filter-status"
            label="Status"
            value={filters.status}
            onChange={(value) => updateFilter("status", value as LeadStatus | "all")}
            options={[
              { value: "all", label: "All statuses" },
              ...LEAD_STATUSES.map((value) => ({
                value,
                label: formatLeadStatus(value),
              })),
            ]}
          />

          <FilterSelect
            id="filter-follow-up"
            label="Follow-up"
            value={filters.followUp}
            onChange={(value) =>
              updateFilter("followUp", value as LeadFollowUpFilter)
            }
            options={FOLLOW_UP_FILTER_OPTIONS}
          />

          <FilterSelect
            id="filter-inspection"
            label="Inspection"
            value={filters.inspection}
            onChange={(value) =>
              updateFilter("inspection", value as LeadInspectionFilter)
            }
            options={INSPECTION_FILTER_OPTIONS}
          />

          <FilterSelect
            id="filter-priority"
            label="Priority"
            value={filters.priority}
            onChange={(value) =>
              updateFilter("priority", value as LeadPriority | "all")
            }
            options={[
              { value: "all", label: "All priorities" },
              ...LEAD_PRIORITIES.map((value) => ({
                value,
                label: getLeadPriorityLabel(value),
              })),
            ]}
          />

          <FilterSelect
            id="filter-project-type"
            label="Project type"
            value={filters.projectType}
            onChange={(value) =>
              updateFilter("projectType", value as LeadProjectType | "all")
            }
            options={[
              { value: "all", label: "All project types" },
              ...LEAD_PROJECT_TYPES.map((value) => ({
                value,
                label: getProjectTypeLabel(value),
              })),
            ]}
          />

          <FilterSelect
            id="filter-source"
            label="Source"
            value={filters.source}
            onChange={(value) => updateFilter("source", value as LeadSource | "all")}
            options={[
              { value: "all", label: "All sources" },
              ...LEAD_SOURCES.map((value) => ({
                value,
                label: getSourceLabel(value),
              })),
            ]}
          />
        </div>

        <p className="mt-4 text-sm text-gray-500">
          Showing {filteredLeads.length} of {visiblePoolCount} lead
          {visiblePoolCount === 1 ? "" : "s"}
          {hasActiveFilters ? " matching your search and filters" : ""}
        </p>
      </div>

      {filteredLeads.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-950 px-6 py-16 text-center">
          <p className="text-sm text-gray-400">No matching leads found.</p>
        </div>
      ) : (
        <LeadListTable leads={filteredLeads} />
      )}
    </div>
  );
}

export function LeadListPanel(props: LeadListPanelProps) {
  return (
    <Suspense
      fallback={
        <div className="rounded-xl border border-gray-800 bg-gray-950 px-6 py-16 text-center text-sm text-gray-400">
          Loading lead filters...
        </div>
      }
    >
      <LeadListPanelContent {...props} />
    </Suspense>
  );
}

type FilterSelectProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
};

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: FilterSelectProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-300">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClassName} mt-2`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
