import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatLeadListEstimateHint,
  formatLeadListPhone,
  hasContactEmail,
  hasContactPhone,
  shouldShowEstimateHint,
} from "./lead-list-display.js";
import type { Lead } from "./leads.js";

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    company_id: "company-1",
    full_name: "Test Lead",
    phone: null,
    email: null,
    address_line_1: null,
    city: null,
    state: null,
    postal_code: null,
    source: "manual",
    status: "new",
    project_type: null,
    description: null,
    insurance_claim: false,
    appointment_at: null,
    estimate_amount: null,
    estimate_sent_at: null,
    last_contacted_at: null,
    follow_up_at: null,
    archived_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

test("formatLeadListPhone returns em dash for empty values", () => {
  assert.equal(formatLeadListPhone(null), "—");
  assert.equal(formatLeadListPhone("402-555-0100"), "402-555-0100");
});

test("estimate hint helpers only apply to estimate_sent and won with amount", () => {
  assert.equal(
    shouldShowEstimateHint(
      makeLead({ status: "estimate_sent", estimate_amount: 12500 }),
    ),
    true,
  );
  assert.equal(
    shouldShowEstimateHint(makeLead({ status: "won", estimate_amount: 9000 })),
    true,
  );
  assert.equal(
    shouldShowEstimateHint(
      makeLead({ status: "estimate_sent", estimate_amount: null }),
    ),
    false,
  );
  assert.equal(
    formatLeadListEstimateHint(
      makeLead({ status: "estimate_sent", estimate_amount: 12500 }),
    ),
    "$12,500.00",
  );
});

test("contact link helpers require trimmed non-empty values", () => {
  assert.equal(hasContactPhone("402-555-0100"), true);
  assert.equal(hasContactPhone("   "), false);
  assert.equal(hasContactEmail("owner@example.com"), true);
  assert.equal(hasContactEmail(null), false);
});
