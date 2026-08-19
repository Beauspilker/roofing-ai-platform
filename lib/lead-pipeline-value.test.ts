import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLeadPipelineValueVisibility,
  contributesToOpenPipelineValue,
  contributesToWonRevenue,
} from "./lead-pipeline-value.js";
import type { Lead } from "./leads.js";

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

test("open pipeline value includes active leads with sent estimates only", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "estimate_sent",
      estimate_amount: 10000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
    makeLead({
      id: "2",
      status: "estimate_sent",
      estimate_amount: 5000,
      estimate_sent_at: "2026-07-11T10:00:00.000Z",
    }),
  ];

  const visibility = computeLeadPipelineValueVisibility(leads);

  assert.equal(visibility.openPipelineValue, 15000);
  assert.equal(visibility.openPipelineLeadCount, 2);
});

test("open pipeline value excludes won, lost, and archived leads", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "won",
      estimate_amount: 9000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
    makeLead({
      id: "2",
      status: "lost",
      estimate_amount: 7000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
    makeLead({
      id: "3",
      status: "estimate_sent",
      estimate_amount: 4000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
      archived_at: "2026-07-12T10:00:00.000Z",
    }),
    makeLead({
      id: "4",
      status: "estimate_sent",
      estimate_amount: 3000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
  ];

  const visibility = computeLeadPipelineValueVisibility(leads);

  assert.equal(visibility.openPipelineValue, 3000);
  assert.equal(visibility.openPipelineLeadCount, 1);
});

test("open pipeline value excludes amounts without estimate_sent_at", () => {
  assert.equal(
    contributesToOpenPipelineValue(
      makeLead({ status: "estimate_sent", estimate_amount: 5000 }),
    ),
    false,
  );
});

test("won revenue sums non-archived won leads separately", () => {
  const leads = [
    makeLead({ id: "1", status: "won", estimate_amount: 12000 }),
    makeLead({ id: "2", status: "won", estimate_amount: 8000 }),
    makeLead({
      id: "3",
      status: "won",
      estimate_amount: 6000,
      archived_at: "2026-07-12T10:00:00.000Z",
    }),
    makeLead({
      id: "4",
      status: "estimate_sent",
      estimate_amount: 5000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
  ];

  const visibility = computeLeadPipelineValueVisibility(leads);

  assert.equal(visibility.wonRevenue, 20000);
  assert.equal(visibility.wonLeadCount, 2);
  assert.equal(contributesToWonRevenue(leads[3]!), false);
});

test("pipeline and won buckets do not double-count the same lead", () => {
  const leads = [
    makeLead({
      id: "1",
      status: "estimate_sent",
      estimate_amount: 10000,
      estimate_sent_at: "2026-07-10T10:00:00.000Z",
    }),
  ];

  const before = computeLeadPipelineValueVisibility(leads);
  assert.equal(before.openPipelineValue, 10000);
  assert.equal(before.wonRevenue, 0);

  const after = computeLeadPipelineValueVisibility([
    { ...leads[0]!, status: "won" },
  ]);

  assert.equal(after.openPipelineValue, 0);
  assert.equal(after.wonRevenue, 10000);
});
