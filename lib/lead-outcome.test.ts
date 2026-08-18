import assert from "node:assert/strict";
import { test } from "node:test";

import type { ActivityHistory } from "./activity.js";
import {
  canMarkLeadWonFromDetail,
  canShowLostOutcomeFields,
  formatLeadLostSummary,
  formatLeadWonSummary,
  getLeadOutcomeFromActivities,
  planMarkLeadLost,
  planMarkLeadWon,
  planPipelineWonAdvance,
  resolveFinalJobAmountForWon,
  shouldIncludeFinalJobAmountInUpdate,
} from "./lead-outcome.js";
import {
  planEstimateSendFromDetail,
  resolveEstimateSentAtUpdate,
} from "./lead-estimate.js";
import {
  planInspectionScheduleFromDetail,
  requiresInspectionDateForPipelineStatus,
} from "./lead-inspection.js";
import {
  isAllowedPipelineStatusTransition,
  canMarkLeadAsLost,
} from "./lead-pipeline.js";
import {
  resolveLastContactedAtUpdate,
  shouldSetLastContactedAt,
} from "./leads.js";

const EXISTING_ESTIMATE = 8500;
const FINAL_JOB_AMOUNT = 9000;
const EXISTING_SENT_AT = "2026-03-01T15:00:00.000Z";
const WON_AT = "2026-07-14T18:00:00.000Z";
const LOST_AT = "2026-07-14T19:00:00.000Z";

function outcomeActivity(
  overrides: Partial<ActivityHistory> & {
    metadata: Record<string, unknown>;
    summary: string;
  },
): ActivityHistory {
  return {
    id: "activity-1",
    company_id: "company-1",
    lead_id: "lead-1",
    activity_type: "status_changed",
    actor_user_id: "user-1",
    created_at: WON_AT,
    ...overrides,
    metadata: overrides.metadata,
    summary: overrides.summary,
  };
}

test("Estimate sent → Won with existing estimate amount", () => {
  const plan = planMarkLeadWon({
    currentStatus: "estimate_sent",
    existingEstimateAmount: EXISTING_ESTIMATE,
    formFinalJobAmountRaw: "",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "won");
  assert.equal(plan.finalJobAmount, EXISTING_ESTIMATE);
  assert.equal(plan.estimateAmountChanged, false);
});

test("pipeline Won advance requires an estimate amount when none exists", () => {
  const result = planPipelineWonAdvance({
    existingEstimateAmount: null,
    formFinalJobAmountRaw: "",
  });

  assert.ok("error" in result);
  assert.match(result.error, /estimate amount/i);
});

test("Won preserves estimate data when final job value matches estimate", () => {
  const plan = planPipelineWonAdvance({
    existingEstimateAmount: EXISTING_ESTIMATE,
    formFinalJobAmountRaw: String(EXISTING_ESTIMATE),
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.estimateAmountChanged, false);
  assert.equal(
    shouldIncludeFinalJobAmountInUpdate(EXISTING_ESTIMATE, EXISTING_ESTIMATE),
    false,
  );
  assert.equal(resolveEstimateSentAtUpdate(EXISTING_SENT_AT, false), undefined);
});

test("Won can update final job value when it differs from the estimate", () => {
  const plan = planMarkLeadWon({
    currentStatus: "estimate_sent",
    existingEstimateAmount: EXISTING_ESTIMATE,
    formFinalJobAmountRaw: String(FINAL_JOB_AMOUNT),
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.finalJobAmount, FINAL_JOB_AMOUNT);
  assert.equal(plan.estimateAmountChanged, true);
});

test("Won activity summary includes amount and timestamp metadata pattern", () => {
  assert.match(
    formatLeadWonSummary(FINAL_JOB_AMOUNT, WON_AT),
    /Lead won: \$9,000\.00 on/,
  );
});

test("getLeadOutcomeFromActivities reads the most recent Won outcome", () => {
  const activities: ActivityHistory[] = [
    outcomeActivity({
      summary: formatLeadWonSummary(FINAL_JOB_AMOUNT, WON_AT),
      created_at: WON_AT,
      metadata: {
        outcome: "won",
        won_at: WON_AT,
        final_job_amount: FINAL_JOB_AMOUNT,
        previous_status: "estimate_sent",
        updated_status: "won",
      },
    }),
  ];

  const outcome = getLeadOutcomeFromActivities(activities);
  assert.ok(outcome);
  assert.equal(outcome.type, "won");
  assert.equal(outcome.recordedAt, WON_AT);
  assert.equal(outcome.finalJobAmount, FINAL_JOB_AMOUNT);
});

test("active lead → Lost with optional reason and notes", () => {
  const plan = planMarkLeadLost({
    currentStatus: "contacted",
    lostReasonRaw: "price",
    lostNotesRaw: "Customer said estimate was too high.",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "lost");
  assert.equal(plan.lostReason, "price");
  assert.equal(plan.lostNotes, "Customer said estimate was too high.");
});

test("Lost activity summary includes reason and notes", () => {
  assert.match(
    formatLeadLostSummary("price", "Customer said estimate was too high."),
    /Lead marked lost: Price too high: Customer said estimate was too high./,
  );
});

test("getLeadOutcomeFromActivities reads Lost outcome metadata", () => {
  const activities: ActivityHistory[] = [
    outcomeActivity({
      summary: formatLeadLostSummary("competitor", null),
      created_at: LOST_AT,
      metadata: {
        outcome: "lost",
        lost_at: LOST_AT,
        lost_reason: "competitor",
        previous_status: "estimate_sent",
        updated_status: "lost",
      },
    }),
  ];

  const outcome = getLeadOutcomeFromActivities(activities);
  assert.ok(outcome);
  assert.equal(outcome.type, "lost");
  assert.equal(outcome.recordedAt, LOST_AT);
  assert.equal(outcome.lostReason, "competitor");
});

test("prior CRM stages remain valid while marking Lost", () => {
  assert.equal(canMarkLeadAsLost("new"), true);
  assert.equal(canMarkLeadAsLost("estimate_sent"), true);
  assert.equal(canMarkLeadAsLost("won"), false);
});

test("unchanged Won plan does not require estimate amount update", () => {
  const resolved = resolveFinalJobAmountForWon(EXISTING_ESTIMATE, "");
  assert.ok(!("error" in resolved));
  assert.equal(resolved.finalJobAmount, EXISTING_ESTIMATE);
});

test("Phase 2.1 allows Estimate sent → Won and alternate Lost transitions", () => {
  assert.equal(
    isAllowedPipelineStatusTransition("estimate_sent", "won"),
    true,
  );
  assert.equal(isAllowedPipelineStatusTransition("new", "lost"), true);
  assert.equal(isAllowedPipelineStatusTransition("won", "lost"), false);
});

test("Phase 2.2 contact tracking remains intact for Won/Lost transitions", () => {
  assert.equal(
    shouldSetLastContactedAt("estimate_sent", "won", null),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate("appointment_scheduled", "lost", null),
    undefined,
  );
});

test("Phase 2.3 inspection tracking remains intact", () => {
  assert.equal(requiresInspectionDateForPipelineStatus("won"), false);
  assert.equal(requiresInspectionDateForPipelineStatus("lost"), false);
  const plan = planInspectionScheduleFromDetail({
    currentStatus: "contacted",
    existingAppointmentAt: null,
    newAppointmentAt: "2026-08-01T14:00:00.000Z",
  });
  assert.ok(!("error" in plan));
});

test("Phase 2.4 estimate tracking remains intact", () => {
  const plan = planEstimateSendFromDetail({
    currentStatus: "appointment_scheduled",
    existingEstimateAmount: null,
    existingEstimateSentAt: null,
    newEstimateAmount: EXISTING_ESTIMATE,
  });
  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "estimate_sent");
});

test("Won/Lost detail helpers expose the correct stages", () => {
  assert.equal(canMarkLeadWonFromDetail("estimate_sent"), true);
  assert.equal(canMarkLeadWonFromDetail("won"), false);
  assert.equal(canShowLostOutcomeFields("estimate_sent"), true);
  assert.equal(canShowLostOutcomeFields("won"), false);
});
