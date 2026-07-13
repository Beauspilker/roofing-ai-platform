"use client";

import { useEffect, useMemo, useState } from "react";
import { submitWebsiteIntake } from "@/app/intake/[companyId]/actions";
import type { PublicIntakeCompany } from "@/lib/intake";
import {
  EMPTY_INTAKE_ANSWERS,
  formatIntakeAnswerLabel,
  formatIntakeAnswerValue,
  getIntakeStepPrompt,
  getIntakeSteps,
  INTAKE_PROJECT_TYPE_OPTIONS,
  INTAKE_URGENCY_OPTIONS,
  isValidIntakeEmail,
  isValidIntakePhone,
  type IntakeAnswers,
  type IntakeStepId,
} from "@/lib/intake";

type IntakeAssistantProps = {
  company: PublicIntakeCompany;
};

function getReviewFields(answers: IntakeAnswers): (keyof IntakeAnswers)[] {
  const fields: (keyof IntakeAnswers)[] = [
    "full_name",
    "phone",
    "email",
    "address_line_1",
    "city",
    "state",
    "postal_code",
    "project_type",
    "description",
    "insurance_claim",
    "urgency",
    "preferred_contact",
  ];

  if (answers.project_type === "storm_damage") {
    fields.splice(fields.indexOf("description"), 0, "storm_damage_details");
  }

  if (answers.insurance_claim) {
    fields.splice(fields.indexOf("urgency"), 0, "adjuster_contacted");
  }

  return fields;
}

export function IntakeAssistant({ company }: IntakeAssistantProps) {
  const [answers, setAnswers] = useState<IntakeAnswers>(EMPTY_INTAKE_ANSWERS);
  const [stepIndex, setStepIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  const steps = useMemo(() => getIntakeSteps(answers), [answers]);
  const currentStep = steps[stepIndex] ?? "review";

  useEffect(() => {
    if (stepIndex >= steps.length) {
      setStepIndex(Math.max(0, steps.length - 1));
    }
  }, [stepIndex, steps.length]);

  useEffect(() => {
    switch (currentStep) {
      case "full_name":
        setInputValue(answers.full_name);
        break;
      case "phone":
        setInputValue(answers.phone);
        break;
      case "email":
        setInputValue(answers.email);
        break;
      case "address_line_1":
        setInputValue(answers.address_line_1);
        break;
      case "city":
        setInputValue(answers.city);
        break;
      case "state":
        setInputValue(answers.state);
        break;
      case "postal_code":
        setInputValue(answers.postal_code);
        break;
      case "project_type":
        setInputValue(answers.project_type);
        break;
      case "storm_damage_details":
        setInputValue(answers.storm_damage_details);
        break;
      case "description":
        setInputValue(answers.description);
        break;
      case "insurance_claim":
        setInputValue(
          answers.insurance_claim === null
            ? ""
            : answers.insurance_claim
              ? "yes"
              : "no",
        );
        break;
      case "adjuster_contacted":
        setInputValue(
          answers.adjuster_contacted === null
            ? ""
            : answers.adjuster_contacted
              ? "yes"
              : "no",
        );
        break;
      case "urgency":
        setInputValue(answers.urgency);
        break;
      case "preferred_contact":
        setInputValue(answers.preferred_contact);
        break;
      default:
        setInputValue("");
    }
  }, [answers, currentStep]);

  function updateAnswer(key: keyof IntakeAnswers, value: string | boolean) {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  function goBack() {
    setError(null);
    setInputValue("");
    setStepIndex((current) => Math.max(0, current - 1));
  }

  function goNext() {
    setError(null);
    setInputValue("");
    setStepIndex((current) => Math.min(steps.length - 1, current + 1));
  }

  function validateCurrentStep(): string | null {
    switch (currentStep) {
      case "full_name":
        return inputValue.trim() ? null : "Full name is required.";
      case "phone":
        return isValidIntakePhone(inputValue)
          ? null
          : "Please enter a valid phone number.";
      case "email":
        if (!inputValue.trim()) {
          return null;
        }
        return isValidIntakeEmail(inputValue)
          ? null
          : "Please enter a valid email address.";
      case "address_line_1":
        return inputValue.trim() ? null : "Property address is required.";
      case "city":
        return inputValue.trim() ? null : "City is required.";
      case "state":
        return inputValue.trim() ? null : "State is required.";
      case "postal_code":
        return inputValue.trim() ? null : "Postal code is required.";
      case "project_type":
        return inputValue ? null : "Please choose a project type.";
      case "storm_damage_details":
        return inputValue.trim() ? null : "Please describe the storm damage.";
      case "description":
        return inputValue.trim() ? null : "Description is required.";
      case "insurance_claim":
      case "adjuster_contacted":
      case "urgency":
        return inputValue ? null : "Please choose an option.";
      default:
        return null;
    }
  }

  function handleContinue() {
    if (currentStep === "welcome" || currentStep === "emergency_notice") {
      goNext();
      return;
    }

    const validationError = validateCurrentStep();

    if (validationError) {
      setError(validationError);
      return;
    }

    if (currentStep === "full_name") updateAnswer("full_name", inputValue.trim());
    if (currentStep === "phone") updateAnswer("phone", inputValue.trim());
    if (currentStep === "email") updateAnswer("email", inputValue.trim());
    if (currentStep === "address_line_1") {
      updateAnswer("address_line_1", inputValue.trim());
    }
    if (currentStep === "city") updateAnswer("city", inputValue.trim());
    if (currentStep === "state") updateAnswer("state", inputValue.trim());
    if (currentStep === "postal_code") updateAnswer("postal_code", inputValue.trim());
    if (currentStep === "project_type") {
      updateAnswer("project_type", inputValue as IntakeAnswers["project_type"]);
    }
    if (currentStep === "storm_damage_details") {
      updateAnswer("storm_damage_details", inputValue.trim());
    }
    if (currentStep === "description") updateAnswer("description", inputValue.trim());
    if (currentStep === "insurance_claim") {
      updateAnswer("insurance_claim", inputValue === "yes");
    }
    if (currentStep === "adjuster_contacted") {
      updateAnswer("adjuster_contacted", inputValue === "yes");
    }
    if (currentStep === "urgency") {
      updateAnswer("urgency", inputValue as IntakeAnswers["urgency"]);
    }
    if (currentStep === "preferred_contact") {
      updateAnswer("preferred_contact", inputValue.trim());
    }

    goNext();
  }

  function handleSkipOptional() {
    if (currentStep === "email") {
      updateAnswer("email", "");
      goNext();
      return;
    }

    if (currentStep === "preferred_contact") {
      updateAnswer("preferred_contact", "");
      goNext();
    }
  }

  async function handleSubmit() {
    if (isSubmitting || isComplete) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await submitWebsiteIntake(company.id, answers);

    if (result.error) {
      setError(result.error);
      setIsSubmitting(false);
      return;
    }

    setIsComplete(true);
    setIsSubmitting(false);
  }

  if (isComplete) {
    return (
      <div className="rounded-xl border border-green-900/50 bg-green-950/30 p-8 text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-green-300">
          Request received
        </p>
        <h2 className="mt-3 text-2xl font-bold text-white">Thank you!</h2>
        <p className="mt-4 text-gray-300">
          {company.company_name} has received your roofing request. A team member
          will follow up using the contact details you provided.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-6 sm:p-8">
        {currentStep === "welcome" ? (
          <div className="space-y-4">
            <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
              Website lead assistant
            </p>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">
              {company.company_name}
            </h1>
            <p className="text-gray-300">
              Welcome! This quick assistant will help you request roofing service.
              Answer a few questions and our team will follow up with you.
            </p>
            <button
              type="button"
              onClick={goNext}
              className="w-full rounded-xl bg-blue-600 px-6 py-4 text-sm font-semibold transition hover:bg-blue-700 sm:w-auto"
            >
              Start request
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
                Step {stepIndex} of {steps.length - 1}
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-white">
                {getIntakeStepPrompt(currentStep)}
              </h2>
            </div>

            {stepIndex > 1 ? (
              <div className="rounded-xl border border-gray-800 bg-black/40 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">
                  Your answers so far
                </p>
                <dl className="mt-3 space-y-2 text-sm">
                  {getReviewFields(answers)
                    .filter((field) => {
                      const value = answers[field];
                      return value !== "" && value !== null;
                    })
                    .map((field) => (
                      <div key={field}>
                        <dt className="text-gray-500">
                          {formatIntakeAnswerLabel(field)}
                        </dt>
                        <dd className="text-gray-200">
                          {formatIntakeAnswerValue(field, answers)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </div>
            ) : null}

            {currentStep === "emergency_notice" ? (
              <div className="rounded-xl border border-yellow-900/50 bg-yellow-950/30 p-4 text-sm text-yellow-100">
                If you are experiencing a life-threatening emergency or active
                structural collapse, call 911 immediately. This form does not
                replace emergency services.
              </div>
            ) : null}

            {currentStep === "review" ? (
              <dl className="space-y-3 text-sm">
                {getReviewFields(answers).map((field) => (
                  <div
                    key={field}
                    className="rounded-xl border border-gray-800 bg-black/40 p-4"
                  >
                    <dt className="text-gray-500">
                      {formatIntakeAnswerLabel(field)}
                    </dt>
                    <dd className="mt-1 text-gray-200">
                      {formatIntakeAnswerValue(field, answers)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {currentStep === "project_type" ? (
              <select
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                className="w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none focus:border-blue-600"
              >
                <option value="">Select project type</option>
                {INTAKE_PROJECT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}

            {currentStep === "urgency" ? (
              <div className="space-y-3">
                {INTAKE_URGENCY_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-800 bg-black px-4 py-3"
                  >
                    <input
                      type="radio"
                      name="urgency"
                      value={option.value}
                      checked={inputValue === option.value}
                      onChange={(event) => setInputValue(event.target.value)}
                      className="mt-1 h-4 w-4 border-gray-700 bg-black text-blue-600"
                    />
                    <span className="text-sm text-gray-200">{option.label}</span>
                  </label>
                ))}
              </div>
            ) : null}

            {currentStep === "insurance_claim" ||
            currentStep === "adjuster_contacted" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setInputValue(option.value)}
                    className={`rounded-xl border px-4 py-3 text-sm font-semibold transition ${
                      inputValue === option.value
                        ? "border-blue-600 bg-blue-950/40 text-blue-200"
                        : "border-gray-800 bg-black text-gray-300 hover:border-gray-700"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}

            {[
              "full_name",
              "phone",
              "email",
              "address_line_1",
              "city",
              "state",
              "postal_code",
              "storm_damage_details",
              "description",
              "preferred_contact",
            ].includes(currentStep) ? (
              currentStep === "description" ||
              currentStep === "storm_damage_details" ? (
                <textarea
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  rows={5}
                  className="w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none placeholder:text-gray-500 focus:border-blue-600"
                  placeholder="Type your answer..."
                />
              ) : (
                <input
                  type={
                    currentStep === "phone"
                      ? "tel"
                      : currentStep === "email"
                        ? "email"
                        : "text"
                  }
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  className="w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none placeholder:text-gray-500 focus:border-blue-600"
                  placeholder="Type your answer..."
                />
              )
            ) : null}

            {error ? (
              <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
                {error}
              </p>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={goBack}
                  disabled={isSubmitting}
                  className="rounded-xl border border-gray-700 px-6 py-3 text-sm font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white disabled:opacity-60"
                >
                  Back
                </button>
              ) : null}

              {currentStep === "email" || currentStep === "preferred_contact" ? (
                <button
                  type="button"
                  onClick={handleSkipOptional}
                  disabled={isSubmitting}
                  className="rounded-xl border border-gray-700 px-6 py-3 text-sm font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white disabled:opacity-60"
                >
                  Skip
                </button>
              ) : null}

              {currentStep === "review" ? (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmitting ? "Submitting..." : "Submit request"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={isSubmitting}
                  className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
