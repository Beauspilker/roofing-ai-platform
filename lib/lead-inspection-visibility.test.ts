import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLeadDashboardVisibility,
  computeLeadPipelineVisibility,
} from "./lead-dashboard-visibility.js";
import {
  hasScheduledInspection,
  isInspectionOverdue,
  isInspectionUpcoming,
} from "./lead-inspection-visibility.js";
import {
  computeLeadDashboardStats,
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  type Lead,
} from "./leads.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const OVERDUE_INSPECTION = "2026-07-10T10:00:00.000Z";
const UPCOMING_INSPECTION = "2026-07-20T10:00:00.000Z";
const OVERDUE_FOLLOW_UP = "2026-07-10T10:00:00.000Z";

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

test("inspection visibility helpers detect scheduled, upcoming, and overdue dates", () => {
  assert.equal(hasScheduledInspection(null), false);
  assert.equal(hasScheduledInspection(UPCOMING_INSPECTION), true);
  assert.equal(isInspectionOverdue(OVERDUE_INSPECTION, NOW), true);
  assert.equal(isInspectionUpcoming(UPCOMING_INSPECTION, NOW), true);
  assert.equal(isInspectionUpcoming(OVERDUE_INSPECTION, NOW), false);
});

test("computeLeadPipelineVisibility counts inspections on active leads only", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "appointment_scheduled",
      appointment_at: OVERDUE_INSPECTION,
    }),
    makeLead({
      id: "2",
      status: "appointment_scheduled",
      appointment_at: UPCOMING_INSPECTION,
    }),
    makeLead({
      id: "3",
      status: "won",
      appointment_at: OVERDUE_INSPECTION,
    }),
    makeLead({
      id: "4",
      status: "contacted",
      appointment_at: UPCOMING_INSPECTION,
      archived_at: "2026-07-01T00:00:00.000Z",
    }),
  ];

  const visibility = computeLeadPipelineVisibility(leads, NOW);

  assert.equal(visibility.inspectionsDue, 2);
  assert.equal(visibility.inspectionsOverdue, 1);
});

test("filterLeads supports inspection upcoming, overdue, and none filters", () => {
  const leads = [
    makeLead({ id: "1", appointment_at: OVERDUE_INSPECTION }),
    makeLead({ id: "2", appointment_at: UPCOMING_INSPECTION }),
    makeLead({ id: "3", appointment_at: null }),
  ];

  const overdue = filterLeads(
    leads,
    { ...DEFAULT_LEAD_FILTERS, inspection: "overdue" },
    NOW,
  );
  const upcoming = filterLeads(
    leads,
    { ...DEFAULT_LEAD_FILTERS, inspection: "upcoming" },
    NOW,
  );
  const none = filterLeads(
    leads,
    { ...DEFAULT_LEAD_FILTERS, inspection: "none" },
    NOW,
  );

  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]?.id, "1");
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0]?.id, "2");
  assert.equal(none.length, 1);
  assert.equal(none[0]?.id, "3");
});

test("inspection filter works together with follow-up filter", () => {
  const leads = [
    makeLead({
      id: "1",
      appointment_at: OVERDUE_INSPECTION,
      follow_up_at: OVERDUE_FOLLOW_UP,
    }),
    makeLead({
      id: "2",
      appointment_at: OVERDUE_INSPECTION,
      follow_up_at: null,
    }),
  ];

  const filtered = filterLeads(
    leads,
    {
      ...DEFAULT_LEAD_FILTERS,
      inspection: "overdue",
      followUp: "overdue",
    },
    NOW,
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, "1");
});

test("computeLeadDashboardVisibility preserves existing dashboard stats", () => {
  const leads = [
    makeLead({ id: "1", status: "new" }),
    makeLead({ id: "2", status: "won" }),
  ];

  const combined = computeLeadDashboardVisibility(leads, NOW);
  const stats = computeLeadDashboardStats(leads);

  assert.deepEqual(combined.stats, stats);
});
