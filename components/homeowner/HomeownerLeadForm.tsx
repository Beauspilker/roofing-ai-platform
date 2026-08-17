"use client";

import { useState } from "react";
import { submitHomeownerLeadAction } from "@/app/homeowner/actions";
import {
  EMPTY_INTAKE_ANSWERS,
  INTAKE_PROJECT_TYPE_OPTIONS,
  INTAKE_URGENCY_OPTIONS,
  type IntakeAnswers,
} from "@/lib/intake";

const inputClassName =
  "mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none";

const labelClassName = "block text-sm font-medium text-gray-300";

export function HomeownerLeadForm() {
  const [answers, setAnswers] = useState<IntakeAnswers>({
    ...EMPTY_INTAKE_ANSWERS,
    insurance_claim: false,
    urgency: "standard",
  });
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateAnswer<K extends keyof IntakeAnswers>(
    key: K,
    value: IntakeAnswers[K],
  ) {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const result = await submitHomeownerLeadAction({
      ...answers,
      consent_to_contact: consent,
      website: honeypot,
    });

    setIsSubmitting(false);

    if (result.success) {
      setSuccessMessage(result.message);
      setAnswers({
        ...EMPTY_INTAKE_ANSWERS,
        insurance_claim: false,
        urgency: "standard",
      });
      setConsent(false);
      setHoneypot("");
      return;
    }

    setError(result.error ?? "Unable to submit your request. Please try again.");
  }

  if (successMessage) {
    return (
      <div className="rounded-2xl border border-green-800 bg-green-950/40 p-8 text-center">
        <h2 className="text-2xl font-semibold text-green-300">Request received</h2>
        <p className="mt-3 text-gray-300">{successMessage}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-2xl border border-gray-800 bg-gray-950/60 p-6 sm:p-8"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClassName} htmlFor="full_name">
            Full name
          </label>
          <input
            id="full_name"
            name="full_name"
            required
            autoComplete="name"
            className={inputClassName}
            value={answers.full_name}
            onChange={(event) => updateAnswer("full_name", event.target.value)}
          />
        </div>

        <div>
          <label className={labelClassName} htmlFor="phone">
            Phone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            className={inputClassName}
            value={answers.phone}
            onChange={(event) => updateAnswer("phone", event.target.value)}
          />
        </div>

        <div>
          <label className={labelClassName} htmlFor="email">
            Email (optional)
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            className={inputClassName}
            value={answers.email}
            onChange={(event) => updateAnswer("email", event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClassName} htmlFor="address_line_1">
            Property address
          </label>
          <input
            id="address_line_1"
            name="address_line_1"
            required
            autoComplete="street-address"
            className={inputClassName}
            value={answers.address_line_1}
            onChange={(event) =>
              updateAnswer("address_line_1", event.target.value)
            }
          />
        </div>

        <div>
          <label className={labelClassName} htmlFor="city">
            City
          </label>
          <input
            id="city"
            name="city"
            required
            autoComplete="address-level2"
            className={inputClassName}
            value={answers.city}
            onChange={(event) => updateAnswer("city", event.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClassName} htmlFor="state">
              State
            </label>
            <input
              id="state"
              name="state"
              required
              autoComplete="address-level1"
              className={inputClassName}
              value={answers.state}
              onChange={(event) => updateAnswer("state", event.target.value)}
            />
          </div>

          <div>
            <label className={labelClassName} htmlFor="postal_code">
              ZIP code
            </label>
            <input
              id="postal_code"
              name="postal_code"
              required
              autoComplete="postal-code"
              inputMode="numeric"
              className={inputClassName}
              value={answers.postal_code}
              onChange={(event) =>
                updateAnswer("postal_code", event.target.value)
              }
            />
          </div>
        </div>

        <div>
          <label className={labelClassName} htmlFor="project_type">
            Project type
          </label>
          <select
            id="project_type"
            name="project_type"
            required
            className={inputClassName}
            value={answers.project_type}
            onChange={(event) =>
              updateAnswer(
                "project_type",
                event.target.value as IntakeAnswers["project_type"],
              )
            }
          >
            <option value="">Select one</option>
            {INTAKE_PROJECT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClassName} htmlFor="urgency">
            Urgency
          </label>
          <select
            id="urgency"
            name="urgency"
            required
            className={inputClassName}
            value={answers.urgency}
            onChange={(event) =>
              updateAnswer(
                "urgency",
                event.target.value as IntakeAnswers["urgency"],
              )
            }
          >
            <option value="">Select one</option>
            {INTAKE_URGENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {answers.project_type === "storm_damage" && (
          <div className="sm:col-span-2">
            <label className={labelClassName} htmlFor="storm_damage_details">
              Storm damage details
            </label>
            <textarea
              id="storm_damage_details"
              name="storm_damage_details"
              required
              rows={3}
              className={inputClassName}
              value={answers.storm_damage_details}
              onChange={(event) =>
                updateAnswer("storm_damage_details", event.target.value)
              }
            />
          </div>
        )}

        <div className="sm:col-span-2">
          <label className={labelClassName} htmlFor="description">
            Describe the issue
          </label>
          <textarea
            id="description"
            name="description"
            required
            rows={4}
            className={inputClassName}
            value={answers.description}
            onChange={(event) => updateAnswer("description", event.target.value)}
            placeholder="Example: Shingles missing after last storm, active leak in the kitchen."
          />
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm text-gray-300">
        <input
          type="checkbox"
          required
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-1"
        />
        <span>
          I agree to be contacted about my roofing request by phone, text, or
          email.
        </span>
      </label>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-xl bg-blue-600 px-6 py-4 text-lg font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Submitting..." : "Get roofing help"}
      </button>
    </form>
  );
}
