"use client";

import { useMemo, useState } from "react";
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
  LEAD_PRIORITIES,
  LEAD_PROJECT_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type Lead,
  type LeadArchiveView,
  type LeadFilterValues,
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

export function LeadListPanel({ leads }: LeadListPanelProps) {
  const [filters, setFilters] = useState<LeadFilterValues>(DEFAULT_LEAD_FILTERS);

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

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
