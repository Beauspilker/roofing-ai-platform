import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSendEstimateFromDetail,
  formatEstimateSentSummary,
  formatEstimateUpdatedSummary,
  normalizeEstimateAmount,
  parseEstimateAmountInput,
  planEstimateSendFromDetail,
  planPipelineEstimateAdvance,
  requiresEstimateForPipelineStatus,
  resolveEstimateActivity,
  resolveEstimateAmountForPipelineAdvance,
  resolveEstimateSentAtUpdate,
  shouldIncludeEstimateAmountInUpdate,
} from "./lead-estimate.js";
import {
  resolveLastContactedAtUpdate,
  shouldSetLastContactedAt,
} from "./leads.js";
import {
  planPipelineInspectionAdvance,
  requiresInspectionDateForPipelineStatus,
} from "./lead-inspection.js";
import {
  isAllowedPipelineStatusTransition,
} from "./lead-pipeline.js";

const EXISTING_AMOUNT = 4500;
const NEW_AMOUNT = 5200;
const EXISTING_SENT_AT = "2026-02-20T16:00:00.000Z";
const FIXED_NOW = new Date("2026-07-13T18:00:00.000Z");

test("Inspection scheduled → Estimate sent with a valid estimate amount", () => {
  const plan = planEstimateSendFromDetail({
    currentStatus: "appointment_scheduled",
    existingEstimateAmount: null,
    existingEstimateSentAt: null,
    newEstimateAmount: NEW_AMOUNT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "estimate_sent");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.estimateActivity, "sent");
  assert.equal(plan.estimateAmount, NEW_AMOUNT);
});

test("pipeline advance requires an estimate amount when none exists", () => {
  const result = planPipelineEstimateAdvance({
    existingEstimateAmount: null,
    existingEstimateSentAt: null,
    formEstimateAmountRaw: "",
  });

  assert.ok("error" in result);
  assert.match(result.error, /estimate amount/i);
});

test("pipeline advance accepts a valid estimate amount", () => {
  const plan = planPipelineEstimateAdvance({
    existingEstimateAmount: null,
    existingEstimateSentAt: null,
    formEstimateAmountRaw: "5200",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "estimate_sent");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.estimateActivity, "sent");
  assert.equal(plan.estimateAmount, NEW_AMOUNT);
});

test("pipeline advance reuses an existing estimate amount", () => {
  const plan = planPipelineEstimateAdvance({
    existingEstimateAmount: EXISTING_AMOUNT,
    existingEstimateSentAt: null,
    formEstimateAmountRaw: "",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.estimateAmount, EXISTING_AMOUNT);
});

test("estimate amount persistence helpers detect unchanged values", () => {
  assert.equal(
    shouldIncludeEstimateAmountInUpdate(EXISTING_AMOUNT, EXISTING_AMOUNT),
    false,
  );
  assert.equal(shouldIncludeEstimateAmountInUpdate(null, NEW_AMOUNT), true);
  assert.equal(
    shouldIncludeEstimateAmountInUpdate(EXISTING_AMOUNT, NEW_AMOUNT),
    true,
  );
  assert.equal(normalizeEstimateAmount("4500.00"), EXISTING_AMOUNT);
});

test("estimate sent timestamp is set only on first send", () => {
  assert.equal(
    resolveEstimateSentAtUpdate(null, true, FIXED_NOW),
    FIXED_NOW.toISOString(),
  );
  assert.equal(
    resolveEstimateSentAtUpdate(EXISTING_SENT_AT, true, FIXED_NOW),
    undefined,
  );
  assert.equal(
    resolveEstimateSentAtUpdate(null, false, FIXED_NOW),
    undefined,
  );
});

test("updating an existing estimate does not change pipeline status", () => {
  const plan = planEstimateSendFromDetail({
    currentStatus: "estimate_sent",
    existingEstimateAmount: EXISTING_AMOUNT,
    existingEstimateSentAt: EXISTING_SENT_AT,
    newEstimateAmount: NEW_AMOUNT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "estimate_sent");
  assert.equal(plan.statusChanged, false);
  assert.equal(plan.estimateActivity, "updated");
});

test("saving the same estimate amount does not create estimate activity", () => {
  const plan = planEstimateSendFromDetail({
    currentStatus: "estimate_sent",
    existingEstimateAmount: EXISTING_AMOUNT,
    existingEstimateSentAt: EXISTING_SENT_AT,
    newEstimateAmount: EXISTING_AMOUNT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.statusChanged, false);
  assert.equal(plan.estimateActivity, "none");
});

test("invalid pipeline progression remains blocked", () => {
  assert.equal(
    isAllowedPipelineStatusTransition("appointment_scheduled", "won"),
    false,
  );
  assert.equal(
    isAllowedPipelineStatusTransition("contacted", "estimate_sent"),
    false,
  );
});

test("activity summaries describe sent and updated estimates", () => {
  assert.match(
    formatEstimateSentSummary(NEW_AMOUNT, EXISTING_SENT_AT),
    /Estimate sent: \$5,200\.00 on/,
  );
  assert.match(
    formatEstimateUpdatedSummary(NEW_AMOUNT),
    /Estimate updated to \$5,200\.00/,
  );
});

test("estimate activity kinds follow first send and update rules", () => {
  assert.equal(
    resolveEstimateActivity(null, null, NEW_AMOUNT, true),
    "sent",
  );
  assert.equal(
    resolveEstimateActivity(EXISTING_SENT_AT, EXISTING_AMOUNT, NEW_AMOUNT, false),
    "updated",
  );
  assert.equal(
    resolveEstimateActivity(
      EXISTING_SENT_AT,
      EXISTING_AMOUNT,
      EXISTING_AMOUNT,
      false,
    ),
    "none",
  );
});

test("requiresEstimateForPipelineStatus applies only to Estimate sent", () => {
  assert.equal(requiresEstimateForPipelineStatus("estimate_sent"), true);
  assert.equal(requiresEstimateForPipelineStatus("won"), false);
  assert.equal(requiresEstimateForPipelineStatus("appointment_scheduled"), false);
});

test("canSendEstimateFromDetail allows inspection scheduled and estimate sent only", () => {
  assert.equal(canSendEstimateFromDetail("appointment_scheduled"), true);
  assert.equal(canSendEstimateFromDetail("estimate_sent"), true);
  assert.equal(canSendEstimateFromDetail("contacted"), false);
});

test("parseEstimateAmountInput rejects invalid and zero amounts", () => {
  assert.ok("error" in parseEstimateAmountInput(""));
  assert.ok("error" in parseEstimateAmountInput("0"));
  assert.ok("error" in parseEstimateAmountInput("abc"));
  assert.deepEqual(parseEstimateAmountInput("5200.50"), {
    estimateAmount: 5200.5,
  });
});

test("resolveEstimateAmountForPipelineAdvance prefers a submitted amount over existing", () => {
  const resolved = resolveEstimateAmountForPipelineAdvance(
    EXISTING_AMOUNT,
    "6100",
  );

  assert.ok(!("error" in resolved));
  assert.equal(resolved.estimateAmount, 6100);
});

test("Phase 2.2 last_contacted_at remains intact for estimate transitions", () => {
  assert.equal(
    shouldSetLastContactedAt("appointment_scheduled", "estimate_sent", null),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate("appointment_scheduled", "estimate_sent", null),
    undefined,
  );
});

test("Phase 2.3 inspection requirements remain intact", () => {
  assert.equal(requiresInspectionDateForPipelineStatus("appointment_scheduled"), true);
  assert.equal(requiresInspectionDateForPipelineStatus("estimate_sent"), false);
  assert.ok("error" in planPipelineInspectionAdvance({
    existingAppointmentAt: null,
    formAppointmentAtRaw: "",
  }));
});

test("Phase 2.1 allows Inspection scheduled to Estimate sent transition", () => {
  assert.equal(
    isAllowedPipelineStatusTransition("appointment_scheduled", "estimate_sent"),
    true,
  );
});
