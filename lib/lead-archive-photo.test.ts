import assert from "node:assert/strict";
import { test } from "node:test";

import { canUploadPhotosToLead, type Lead } from "./leads.js";

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: overrides.id ?? "lead-1",
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

test("canUploadPhotosToLead allows active leads", () => {
  assert.equal(canUploadPhotosToLead(makeLead({ status: "estimate_sent" })), true);
});

test("canUploadPhotosToLead blocks archived leads", () => {
  assert.equal(
    canUploadPhotosToLead(
      makeLead({
        status: "archived",
        archived_at: "2026-07-12T10:00:00.000Z",
      }),
    ),
    false,
  );
});

test("canUploadPhotosToLead blocks leads with archived_at even if status differs", () => {
  assert.equal(
    canUploadPhotosToLead(
      makeLead({
        status: "estimate_sent",
        archived_at: "2026-07-12T10:00:00.000Z",
      }),
    ),
    false,
  );
});
