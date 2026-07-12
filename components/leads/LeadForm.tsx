"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  LeadFormCheckbox,
  LeadFormField,
  LeadFormSelect,
  LeadFormTextarea,
} from "@/components/leads/LeadFormFields";
import {
  formatLeadStatus,
  getLeadFormValues,
  getLeadPriorityLabel,
  getProjectTypeLabel,
  getSourceLabel,
  LEAD_PRIORITIES,
  LEAD_PROJECT_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type Lead,
  type LeadFormState,
  type LeadFormValues,
  type LeadPriority,
  type LeadStatus,
} from "@/lib/leads";

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

const defaultFormValues: LeadFormValues = {
  full_name: "",
  phone: "",
  email: "",
  address_line_1: "",
  city: "",
  state: "",
  postal_code: "",
  source: "manual",
  status: "new",
  project_type: "",
  description: "",
  insurance_claim: true,
  appointment_at: "",
  priority: "high",
};

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

type LeadFormProps = {
  action: (
    prevState: LeadFormState,
    formData: FormData,
  ) => Promise<LeadFormState>;
  initialLead?: Lead;
  leadId?: string;
  submitLabel: string;
  pendingLabel: string;
  cancelHref: string;
};

export function LeadForm({
  action,
  initialLead,
  leadId,
  submitLabel,
  pendingLabel,
  cancelHref,
}: LeadFormProps) {
  const initialValues = initialLead
    ? getLeadFormValues(initialLead)
    : defaultFormValues;

  const [state, formAction, pending] = useActionState(action, {
    error: null,
  });
  const [priority, setPriority] = useState<LeadPriority>(initialValues.priority);
  const [status, setStatus] = useState<LeadStatus>(initialValues.status);
  const [insuranceClaim, setInsuranceClaim] = useState(
    initialValues.insurance_claim,
  );
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
      {leadId ? <input type="hidden" name="lead_id" value={leadId} /> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <LeadFormField
          id="full_name"
          label="Full name"
          required
          autoComplete="name"
          defaultValue={initialValues.full_name}
        />
        <LeadFormField
          id="phone"
          label="Phone"
          type="tel"
          autoComplete="tel"
          defaultValue={initialValues.phone}
        />
      </div>

      <LeadFormField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        defaultValue={initialValues.email}
      />

      <LeadFormField
        id="address_line_1"
        label="Property address"
        autoComplete="street-address"
        defaultValue={initialValues.address_line_1}
      />

      <div className="grid gap-5 sm:grid-cols-3">
        <LeadFormField
          id="city"
          label="City"
          autoComplete="address-level2"
          defaultValue={initialValues.city}
        />
        <LeadFormField
          id="state"
          label="State"
          autoComplete="address-level1"
          defaultValue={initialValues.state}
        />
        <LeadFormField
          id="postal_code"
          label="Postal code"
          autoComplete="postal-code"
          defaultValue={initialValues.postal_code}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <LeadFormSelect
          id="source"
          label="Source"
          required
          defaultValue={initialValues.source}
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
          defaultValue={initialValues.project_type}
          options={projectTypeOptions}
        />
      </div>

      <LeadFormField
        id="appointment_at"
        label="Appointment date"
        type="datetime-local"
        defaultValue={initialValues.appointment_at}
      />

      <LeadFormTextarea
        id="description"
        label="Description"
        defaultValue={initialValues.description}
      />

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
          {pending ? pendingLabel : submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="rounded-xl border border-gray-800 px-8 py-4 text-center text-lg font-semibold text-gray-300 transition hover:border-gray-700 hover:text-white"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
