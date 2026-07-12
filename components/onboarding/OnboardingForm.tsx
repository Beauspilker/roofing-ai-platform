"use client";

import { useActionState } from "react";
import { AuthField } from "@/components/auth/AuthField";
import {
  createCompanyProfile,
  type OnboardingState,
} from "@/app/onboarding/actions";

const initialState: OnboardingState = { error: null };

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(
    createCompanyProfile,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <AuthField id="company_name" label="Company name" required />
        <AuthField id="owner_name" label="Owner name" required />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <AuthField
          id="business_phone"
          label="Business phone"
          type="tel"
          required={false}
          autoComplete="tel"
        />
        <AuthField
          id="business_email"
          label="Business email"
          type="email"
          required={false}
          autoComplete="email"
        />
      </div>

      <AuthField id="service_area" label="Service area" required={false} />

      <AuthField
        id="years_in_business"
        label="Years in business"
        type="number"
        required={false}
        min={0}
      />

      {state.error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving..." : "Complete setup"}
      </button>
    </form>
  );
}
