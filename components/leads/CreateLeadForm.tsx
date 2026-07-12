"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  createLead,
  type CreateLeadState,
} from "@/app/dashboard/leads/new/actions";
import {
  LeadFormCheckbox,
  LeadFormField,
  LeadFormSelect,
  LeadFormTextarea,
} from "@/components/leads/LeadFormFields";
import {
  formatLeadStatus,
  getLeadPriorityLabel,
  getProjectTypeLabel,
  getSourceLabel,
  LEAD_PRIORITIES,
  LEAD_PROJECT_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type LeadPriority,
  type LeadStatus,
} from "@/lib/leads";

const initialState: CreateLeadState = { error: null };

const sourceOptions = LEAD_SOURCES.map((value) => ({
  value,
  label: getSourceLabel(value),
}));

const statusOptions = LEAD_STATUSES.map((value) => ({
  value,
  label: formatLeadStatus(value),
}));

const projectTypeOptions = [
  { value: "", label: "Select project type" },
  ...LEAD_PROJECT_TYPES.map((value) => ({
    value,
    label: getProjectTypeLabel(value),
  })),
];

const priorityOptions = LEAD_PRIORITIES.map((value) => ({
  value,
  label: getLeadPriorityLabel(value),
}));

function applyPriorityDefaults(priority: LeadPriority): {
  status: LeadStatus;
  insuranceClaim: boolean;
} {
  if (priority === "high") {
    return { status: "new", insuranceClaim: true };
  }

  if (priority === "medium") {
    return { status: "contacted", insuranceClaim: false };
  }

  return { status: "estimate_sent", insuranceClaim: false };
}

export function CreateLeadForm() {
  const [state, formAction, pending] = useActionState(
    createLead,
    initialState,
  );
  const [priority, setPriority] = useState<LeadPriority>("high");
  const [status, setStatus] = useState<LeadStatus>("new");
  const [insuranceClaim, setInsuranceClaim] = useState(true);
  const [formKey, setFormKey] = useState(0);

  function handlePriorityChange(nextPriority: LeadPriority) {
    setPriority(nextPriority);
    const defaults = applyPriorityDefaults(nextPriority);
    setStatus(defaults.status);
    setInsuranceClaim(defaults.insuranceClaim);
    setFormKey((current) => current + 1);
  }

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <LeadFormField
          id="full_name"
          label="Full name"
          required
          autoComplete="name"
        />
        <LeadFormField
          id="phone"
          label="Phone"
          type="tel"
          autoComplete="tel"
        />
      </div>

      <LeadFormField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
      />

      <LeadFormField
        id="address_line_1"
        label="Property address"
        autoComplete="street-address"
      />

      <div className="grid gap-5 sm:grid-cols-3">
        <LeadFormField id="city" label="City" autoComplete="address-level2" />
        <LeadFormField
          id="state"
          label="State"
          autoComplete="address-level1"
        />
        <LeadFormField
          id="postal_code"
          label="Postal code"
          autoComplete="postal-code"
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <LeadFormSelect
          id="source"
          label="Source"
          required
          defaultValue="manual"
          options={sourceOptions}
        />
        <LeadFormSelect
          id="priority"
          label="Priority"
          required
          defaultValue={priority}
          options={priorityOptions}
          onChange={(value) => handlePriorityChange(value as LeadPriority)}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <LeadFormSelect
          key={`status-${formKey}`}
          id="status"
          label="Status"
          required
          defaultValue={status}
          options={statusOptions}
          onChange={(value) => setStatus(value as LeadStatus)}
        />
        <LeadFormSelect
          id="project_type"
          label="Project type"
          options={projectTypeOptions}
        />
      </div>

      <LeadFormTextarea id="description" label="Description" />

      <LeadFormCheckbox
        key={`insurance-${formKey}`}
        id="insurance_claim"
        name="insurance_claim"
        label="This lead involves an insurance claim"
        defaultChecked={insuranceClaim}
        onChange={setInsuranceClaim}
      />

      <p className="text-xs text-gray-500">
        Priority is saved through status and insurance claim settings. It is
        calculated the same way on the dashboard.
      </p>

      {state.error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving lead..." : "Save lead"}
        </button>
        <Link
          href="/dashboard"
          className="rounded-xl border border-gray-800 px-8 py-4 text-center text-lg font-semibold text-gray-300 transition hover:border-gray-700 hover:text-white"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
