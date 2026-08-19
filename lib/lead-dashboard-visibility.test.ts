import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLeadDashboardVisibility,
  computeLeadPipelineVisibility,
} from "./lead-dashboard-visibility.js";
import { isFollowUpOverdue } from "./lead-follow-up.js";
import {
  planMarkLeadLost,
  planMarkLeadWon,
} from "./lead-outcome.js";
import {
  computeLeadDashboardStats,
  filterLeads,
  DEFAULT_LEAD_FILTERS,
  type Lead,
} from "./leads.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const OVERDUE_FOLLOW_UP = "2026-07-10T10:00:00.000Z";
const UPCOMING_FOLLOW_UP = "2026-07-20T10:00:00.000Z";

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

test("computeLeadPipelineVisibility counts active pipeline stages", () => {
  const leads = [
    makeLead({ id: "1", status: "new" }),
    makeLead({ id: "2", status: "contacted" }),
    makeLead({ id: "3", status: "appointment_scheduled" }),
    makeLead({ id: "4", status: "estimate_sent" }),
  ];

  const visibility = computeLeadPipelineVisibility(leads, NOW);

  assert.equal(visibility.pipelineStageCounts.new, 1);
  assert.equal(visibility.pipelineStageCounts.contacted, 1);
  assert.equal(visibility.pipelineStageCounts.appointment_scheduled, 1);
  assert.equal(visibility.pipelineStageCounts.estimate_sent, 1);
});

test("computeLeadPipelineVisibility counts won and lost for non-archived leads", () => {
  const leads = [
    makeLead({ id: "1", status: "won" }),
    makeLead({ id: "2", status: "lost" }),
    makeLead({ id: "3", status: "won", archived_at: "2026-07-01T00:00:00.000Z" }),
  ];

  const visibility = computeLeadPipelineVisibility(leads, NOW);

  assert.equal(visibility.wonCount, 1);
  assert.equal(visibility.lostCount, 1);
});

test("computeLeadPipelineVisibility counts follow-ups due and overdue on active leads", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "contacted",
      follow_up_at: OVERDUE_FOLLOW_UP,
    }),
    makeLead({
      id: "2",
      status: "estimate_sent",
      follow_up_at: UPCOMING_FOLLOW_UP,
    }),
    makeLead({
      id: "3",
      status: "won",
      follow_up_at: OVERDUE_FOLLOW_UP,
    }),
  ];

  const visibility = computeLeadPipelineVisibility(leads, NOW);

  assert.equal(visibility.followUpsDue, 2);
  assert.equal(visibility.followUpsOverdue, 1);
  assert.equal(isFollowUpOverdue(OVERDUE_FOLLOW_UP, NOW), true);
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

test("filterLeads supports follow-up due and overdue filters", () => {
  const leads = [
    makeLead({ id: "1", follow_up_at: OVERDUE_FOLLOW_UP }),
    makeLead({ id: "2", follow_up_at: UPCOMING_FOLLOW_UP }),
    makeLead({ id: "3", follow_up_at: null }),
  ];

  const overdue = filterLeads(leads, {
    ...DEFAULT_LEAD_FILTERS,
    followUp: "overdue",
  }, NOW);
  const due = filterLeads(leads, {
    ...DEFAULT_LEAD_FILTERS,
    followUp: "due",
  }, NOW);
  const none = filterLeads(leads, {
    ...DEFAULT_LEAD_FILTERS,
    followUp: "none",
  }, NOW);

  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]?.id, "1");
  assert.equal(due.length, 2);
  assert.equal(none.length, 1);
  assert.equal(none[0]?.id, "3");
});

test("Phase 2.5 won/lost planning remains intact", () => {
  const wonPlan = planMarkLeadWon({
    currentStatus: "estimate_sent",
    existingEstimateAmount: 8500,
    formFinalJobAmountRaw: "",
  });
  const lostPlan = planMarkLeadLost({
    currentStatus: "new",
    lostReasonRaw: "price",
    lostNotesRaw: "",
  });

  assert.ok(!("error" in wonPlan));
  assert.ok(!("error" in lostPlan));
});

test("existing dashboard stats exclude won/lost from total active leads", () => {
  const leads = [
    makeLead({ id: "1", status: "new" }),
    makeLead({ id: "2", status: "won" }),
    makeLead({ id: "3", status: "lost" }),
  ];

  const stats = computeLeadDashboardStats(leads);

  assert.equal(stats.totalActiveLeads, 1);
});
