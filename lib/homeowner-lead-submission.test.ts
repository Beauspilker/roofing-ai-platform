import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import type { IntakeAnswers } from "./intake.js";
import {
  __setHomeownerLeadSubmissionRuntimeForTests,
  submitHomeownerLead,
} from "./homeowner-lead-submission.js";
import type { HomeownerLeadSubmissionInput } from "./homeowner-lead-qualification.js";

const PILOT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function validSubmission(
  overrides: Partial<HomeownerLeadSubmissionInput> = {},
): HomeownerLeadSubmissionInput {
  return {
    full_name: "Jane Homeowner",
    phone: "(402) 555-0199",
    email: "jane@example.com",
    address_line_1: "123 Main Street",
    city: "Beatrice",
    state: "NE",
    postal_code: "68310",
    project_type: "repair",
    storm_damage_details: "",
    description: "Active roof leak above the kitchen after recent storms.",
    insurance_claim: false,
    adjuster_contacted: null,
    urgency: "standard",
    preferred_contact: "",
    consent_to_contact: true,
    website: "",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.PILOT_COMPANY_ID = PILOT_ID;
  delete process.env.PILOT_ZIP_PREFIXES;
  __setHomeownerLeadSubmissionRuntimeForTests(null);
});

afterEach(() => {
  delete process.env.PILOT_COMPANY_ID;
  delete process.env.PILOT_ZIP_PREFIXES;
  __setHomeownerLeadSubmissionRuntimeForTests(null);
});

test("valid homeowner submission creates lead for pilot company and notifies employees", async () => {
  const createLead = mock.fn(async (_client, companyId: string, _answers: IntakeAnswers) => {
    assert.equal(companyId, PILOT_ID);
    return "lead-website-1";
  });
  const notifyEmployees = mock.fn(async () => ({ status: "sent" as const, channels: ["sms"] as const }));
  const logQualificationActivity = mock.fn(async () => {});

  __setHomeownerLeadSubmissionRuntimeForTests({
    createClient: () => ({}) as never,
    createLead,
    notifyEmployees,
    logQualificationActivity,
  });

  const result = await submitHomeownerLead(validSubmission());

  assert.equal(result.status, "success");
  assert.equal(createLead.mock.callCount(), 1);
  assert.equal(notifyEmployees.mock.callCount(), 1);
  assert.deepEqual(notifyEmployees.mock.calls[0]?.arguments[0], {
    companyId: PILOT_ID,
    leadId: "lead-website-1",
    answers: expectAnswersShape(),
  });
});

test("validation failure from lead creation returns validation_error", async () => {
  __setHomeownerLeadSubmissionRuntimeForTests({
    createClient: () => ({}) as never,
    createLead: mock.fn(async () => {
      throw new Error("Please enter a valid phone number.");
    }),
    notifyEmployees: mock.fn(async () => ({ status: "sent" as const, channels: [] })),
    logQualificationActivity: mock.fn(async () => {}),
  });

  const result = await submitHomeownerLead(validSubmission());

  assert.equal(result.status, "validation_error");
  assert.match(result.message, /phone/i);
});

test("qualification failure does not create a lead", async () => {
  const createLead = mock.fn(async () => "lead-should-not-be-created");
  const notifyEmployees = mock.fn(async () => ({ status: "sent" as const, channels: [] }));

  __setHomeownerLeadSubmissionRuntimeForTests({
    createClient: () => ({}) as never,
    createLead,
    notifyEmployees,
    logQualificationActivity: mock.fn(async () => {}),
  });

  const result = await submitHomeownerLead(
    validSubmission({ consent_to_contact: false }),
  );

  assert.equal(result.status, "qualification_error");
  assert.equal(createLead.mock.callCount(), 0);
  assert.equal(notifyEmployees.mock.callCount(), 0);
});

test("notification failure does not fail homeowner submission", async () => {
  __setHomeownerLeadSubmissionRuntimeForTests({
    createClient: () => ({}) as never,
    createLead: mock.fn(async () => "lead-website-2"),
    notifyEmployees: mock.fn(async () => {
      throw new Error("Twilio unavailable");
    }),
    logQualificationActivity: mock.fn(async () => {}),
  });

  const result = await submitHomeownerLead(validSubmission());

  assert.equal(result.status, "success");
});

test("routes only to configured pilot company id", async () => {
  const createLead = mock.fn(async (_client, companyId: string) => {
    assert.equal(companyId, PILOT_ID);
    assert.notEqual(companyId, OTHER_COMPANY_ID);
    return "lead-website-3";
  });

  __setHomeownerLeadSubmissionRuntimeForTests({
    createClient: () => ({}) as never,
    createLead,
    notifyEmployees: mock.fn(async () => ({ status: "skipped" as const, reason: "disabled" })),
    logQualificationActivity: mock.fn(async () => {}),
  });

  const result = await submitHomeownerLead(validSubmission());

  assert.equal(result.status, "success");
  assert.equal(createLead.mock.callCount(), 1);
});

function expectAnswersShape() {
  return {
    full_name: "Jane Homeowner",
    phone: "(402) 555-0199",
    email: "jane@example.com",
    address_line_1: "123 Main Street",
    city: "Beatrice",
    state: "NE",
    postal_code: "68310",
    project_type: "repair",
    storm_damage_details: "",
    description: "Active roof leak above the kitchen after recent storms.",
    insurance_claim: false,
    adjuster_contacted: null,
    urgency: "standard",
    preferred_contact: "",
  };
}
