import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  resolveUrlControlledLeadFilters,
  type Lead,
} from "./leads.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

function makeSearchParams(params: Record<string, string>) {
  return {
    get(name: string) {
      return params[name] ?? null;
    },
  };
}

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

test("resolveUrlControlledLeadFilters defaults URL-controlled filters to all", () => {
  const resolved = resolveUrlControlledLeadFilters(makeSearchParams({}));

  assert.deepEqual(resolved, {
    status: "all",
    followUp: "all",
    inspection: "all",
    attention: "all",
    forceActiveArchiveView: false,
  });
});

test("resolveUrlControlledLeadFilters reads valid dashboard URL params", () => {
  const resolved = resolveUrlControlledLeadFilters(
    makeSearchParams({
      status: "estimate_sent",
      followUp: "overdue",
      inspection: "upcoming",
      attention: "needs",
    }),
  );

  assert.deepEqual(resolved, {
    status: "estimate_sent",
    followUp: "overdue",
    inspection: "upcoming",
    attention: "needs",
    forceActiveArchiveView: true,
  });
});

test("resolveUrlControlledLeadFilters ignores invalid URL params", () => {
  const resolved = resolveUrlControlledLeadFilters(
    makeSearchParams({
      status: "invalid",
      followUp: "invalid",
      inspection: "invalid",
      attention: "invalid",
    }),
  );

  assert.deepEqual(resolved, {
    status: "all",
    followUp: "all",
    inspection: "all",
    attention: "all",
    forceActiveArchiveView: false,
  });
});

test("resolveUrlControlledLeadFilters clears stale attention when only status is in URL", () => {
  const attentionOnly = resolveUrlControlledLeadFilters(
    makeSearchParams({ attention: "needs" }),
  );
  const statusOnly = resolveUrlControlledLeadFilters(
    makeSearchParams({ status: "estimate_sent" }),
  );

  assert.equal(attentionOnly.attention, "needs");
  assert.equal(attentionOnly.status, "all");

  assert.equal(statusOnly.status, "estimate_sent");
  assert.equal(statusOnly.attention, "all");
});

test("dashboard card navigation filters do not combine stale URL dimensions", () => {
  const leads = [
    makeLead({ id: "needs-new", status: "new" }),
    makeLead({ id: "estimate-sent", status: "estimate_sent" }),
  ];

  const needsAttentionFilters = {
    ...DEFAULT_LEAD_FILTERS,
    ...resolveUrlControlledLeadFilters(makeSearchParams({ attention: "needs" })),
    archiveView: "active" as const,
  };

  const estimateSentFilters = {
    ...DEFAULT_LEAD_FILTERS,
    ...resolveUrlControlledLeadFilters(
      makeSearchParams({ status: "estimate_sent" }),
    ),
    archiveView: "active" as const,
  };

  const needsAttentionResults = filterLeads(leads, needsAttentionFilters, NOW);
  const estimateSentResults = filterLeads(leads, estimateSentFilters, NOW);

  assert.deepEqual(
    needsAttentionResults.map((lead) => lead.id),
    ["needs-new"],
  );
  assert.deepEqual(
    estimateSentResults.map((lead) => lead.id),
    ["estimate-sent"],
  );
});
