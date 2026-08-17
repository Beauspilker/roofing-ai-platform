import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  qualifyHomeownerLeadSubmission,
  qualifiesHomeownerDescription,
  type HomeownerLeadSubmissionInput,
} from "./homeowner-lead-qualification.js";

const PILOT_ID = "11111111-1111-4111-8111-111111111111";

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
});

afterEach(() => {
  delete process.env.PILOT_COMPANY_ID;
  delete process.env.PILOT_ZIP_PREFIXES;
});

test("qualifies a valid homeowner submission", () => {
  const result = qualifyHomeownerLeadSubmission(validSubmission());

  assert.deepEqual(result, {
    status: "qualified",
    companyId: PILOT_ID,
  });
});

test("rejects honeypot submissions", () => {
  const result = qualifyHomeownerLeadSubmission(
    validSubmission({ website: "https://spam.test" }),
  );

  assert.equal(result.status, "unqualified");
});

test("rejects missing consent", () => {
  const result = qualifyHomeownerLeadSubmission(
    validSubmission({ consent_to_contact: false }),
  );

  assert.equal(result.status, "unqualified");
  assert.match(result.reason, /Consent/i);
});

test("rejects invalid phone numbers", () => {
  const result = qualifyHomeownerLeadSubmission(
    validSubmission({ phone: "123" }),
  );

  assert.equal(result.status, "unqualified");
  assert.match(result.reason, /phone/i);
});

test("rejects zips outside pilot territory", () => {
  process.env.PILOT_ZIP_PREFIXES = "683";

  const result = qualifyHomeownerLeadSubmission(
    validSubmission({ postal_code: "90210" }),
  );

  assert.equal(result.status, "unqualified");
  assert.match(result.reason, /service area/i);
});

test("returns needs_review for short descriptions", () => {
  const result = qualifyHomeownerLeadSubmission(
    validSubmission({ description: "leak" }),
  );

  assert.equal(result.status, "needs_review");
});

test("qualifiesHomeownerDescription rejects spam patterns", () => {
  assert.equal(
    qualifiesHomeownerDescription("Visit https://spam.test for cheap roofs"),
    false,
  );
});

test("returns unavailable when pilot routing is misconfigured", () => {
  delete process.env.PILOT_COMPANY_ID;

  const result = qualifyHomeownerLeadSubmission(validSubmission());

  assert.equal(result.status, "unqualified");
  assert.match(result.reason, /temporarily unavailable/i);
});
