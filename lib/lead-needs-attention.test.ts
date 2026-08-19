import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLeadNeedsAttentionVisibility,
  isLeadNeedingAttention,
} from "./lead-needs-attention.js";
import {
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  type Lead,
} from "./leads.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const OVERDUE_FOLLOW_UP = "2026-07-10T10:00:00.000Z";
const OVERDUE_INSPECTION = "2026-07-10T10:00:00.000Z";

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

test("needs attention includes awaiting contact, overdue follow-up, and overdue inspection", () => {
  assert.equal(isLeadNeedingAttention(makeLead({ id: "1", status: "new" }), NOW), true);
  assert.equal(
    isLeadNeedingAttention(
      makeLead({
        id: "2",
        status: "contacted",
        follow_up_at: OVERDUE_FOLLOW_UP,
      }),
      NOW,
    ),
    true,
  );
  assert.equal(
    isLeadNeedingAttention(
      makeLead({
        id: "3",
        status: "appointment_scheduled",
        appointment_at: OVERDUE_INSPECTION,
      }),
      NOW,
    ),
    true,
  );
});

test("needs attention excludes won, lost, and archived leads", () => {
  assert.equal(
    isLeadNeedingAttention(
      makeLead({ id: "1", status: "won", follow_up_at: OVERDUE_FOLLOW_UP }),
      NOW,
    ),
    false,
  );
  assert.equal(
    isLeadNeedingAttention(
      makeLead({ id: "2", status: "lost", follow_up_at: OVERDUE_FOLLOW_UP }),
      NOW,
    ),
    false,
  );
  assert.equal(
    isLeadNeedingAttention(
      makeLead({
        id: "3",
        status: "new",
        archived_at: "2026-07-01T00:00:00.000Z",
      }),
      NOW,
    ),
    false,
  );
});

test("needs attention deduplicates leads matching multiple conditions", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "new",
      follow_up_at: OVERDUE_FOLLOW_UP,
      appointment_at: OVERDUE_INSPECTION,
    }),
    makeLead({ id: "2", status: "contacted" }),
  ];

  const visibility = computeLeadNeedsAttentionVisibility(leads, NOW);

  assert.equal(visibility.needsAttentionCount, 1);
  assert.equal(visibility.awaitingContactCount, 1);
  assert.equal(visibility.overdueFollowUpCount, 1);
  assert.equal(visibility.overdueInspectionCount, 1);
});

test("filterLeads supports attention=needs", () => {
  const leads = [
    makeLead({ id: "1", status: "new" }),
    makeLead({ id: "2", status: "contacted" }),
  ];

  const filtered = filterLeads(
    leads,
    { ...DEFAULT_LEAD_FILTERS, attention: "needs" },
    NOW,
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, "1");
});

test("attention filter combines with follow-up overdue filter", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "new",
      follow_up_at: OVERDUE_FOLLOW_UP,
    }),
    makeLead({
      id: "2",
      status: "contacted",
      follow_up_at: OVERDUE_FOLLOW_UP,
    }),
    makeLead({
      id: "3",
      status: "contacted",
      follow_up_at: "2026-07-20T10:00:00.000Z",
    }),
  ];

  const filtered = filterLeads(
    leads,
    {
      ...DEFAULT_LEAD_FILTERS,
      attention: "needs",
      followUp: "overdue",
    },
    NOW,
  );

  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((lead) => lead.id).sort(),
    ["1", "2"],
  );
});
