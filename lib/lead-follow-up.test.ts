import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canCompleteFollowUpFromDetail,
  canScheduleFollowUpFromDetail,
  formatFollowUpCompletedSummary,
  formatFollowUpRescheduledSummary,
  formatFollowUpScheduledSummary,
  hasOpenFollowUp,
  isFollowUpOverdue,
  parseFollowUpAtInput,
  planFollowUpComplete,
  planFollowUpScheduleFromDetail,
  resolveFollowUpActivityKind,
  shouldIncludeFollowUpAtInUpdate,
} from "./lead-follow-up.js";
import {
  planEstimateSendFromDetail,
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
  planMarkLeadLost,
  planMarkLeadWon,
} from "./lead-outcome.js";
import {
  resolveLastContactedAtUpdate,
  shouldSetLastContactedAt,
} from "./leads.js";

const EXISTING_FOLLOW_UP = "2026-03-15T14:30:00.000Z";
const NEW_FOLLOW_UP = "2026-03-20T16:00:00.000Z";
const LOCAL_INPUT = "2026-03-20T11:00";
const COMPLETED_AT = "2026-07-14T18:00:00.000Z";

const activeLead = {
  status: "contacted",
  archived_at: null as string | null,
  follow_up_at: null as string | null,
};

test("schedule first follow-up for an active lead", () => {
  const parsed = parseFollowUpAtInput(LOCAL_INPUT);
  assert.ok("followUpAt" in parsed);

  const plan = planFollowUpScheduleFromDetail({
    lead: activeLead,
    existingFollowUpAt: null,
    newFollowUpAt: parsed.followUpAt,
    followUpNotesRaw: "Call back about estimate",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.followUpActivity, "scheduled");
  assert.equal(plan.followUpNotes, "Call back about estimate");
});

test("reschedule an existing follow-up to a new time", () => {
  const plan = planFollowUpScheduleFromDetail({
    lead: { ...activeLead, follow_up_at: EXISTING_FOLLOW_UP },
    existingFollowUpAt: EXISTING_FOLLOW_UP,
    newFollowUpAt: NEW_FOLLOW_UP,
    followUpNotesRaw: "",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.followUpActivity, "rescheduled");
  assert.equal(plan.followUpAt, NEW_FOLLOW_UP);
});

test("unchanged follow-up time does not require an update", () => {
  assert.equal(
    resolveFollowUpActivityKind(EXISTING_FOLLOW_UP, EXISTING_FOLLOW_UP),
    "none",
  );
  assert.equal(
    shouldIncludeFollowUpAtInUpdate(EXISTING_FOLLOW_UP, EXISTING_FOLLOW_UP),
    false,
  );
});

test("complete follow-up clears open follow-up state in plan metadata", () => {
  const plan = planFollowUpComplete({
    lead: {
      ...activeLead,
      follow_up_at: EXISTING_FOLLOW_UP,
    },
    followUpNotesRaw: "Reached homeowner",
    completedAt: COMPLETED_AT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.followUpActivity, "completed");
  assert.equal(plan.previousFollowUpAt, EXISTING_FOLLOW_UP);
  assert.equal(plan.completedAt, COMPLETED_AT);
  assert.equal(plan.followUpNotes, "Reached homeowner");
});

test("overdue follow-up detection works for past due dates", () => {
  assert.equal(isFollowUpOverdue(null), false);
  assert.equal(
    isFollowUpOverdue(
      "2020-01-01T12:00:00.000Z",
      new Date("2026-01-01T00:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isFollowUpOverdue(
      "2030-01-01T12:00:00.000Z",
      new Date("2026-01-01T00:00:00.000Z"),
    ),
    false,
  );
});

test("hasOpenFollowUp reflects scheduled follow-up state", () => {
  assert.equal(hasOpenFollowUp(null), false);
  assert.equal(hasOpenFollowUp(EXISTING_FOLLOW_UP), true);
});

test("activity summaries describe scheduled, rescheduled, and completed follow-ups", () => {
  assert.match(
    formatFollowUpScheduledSummary(EXISTING_FOLLOW_UP),
    /Follow-up scheduled for/,
  );
  assert.match(
    formatFollowUpRescheduledSummary(NEW_FOLLOW_UP),
    /Follow-up rescheduled to/,
  );
  assert.match(
    formatFollowUpCompletedSummary(EXISTING_FOLLOW_UP),
    /Follow-up completed for/,
  );
});

test("closed and archived leads cannot schedule follow-ups", () => {
  assert.equal(canScheduleFollowUpFromDetail({ status: "won", archived_at: null }), false);
  assert.equal(canScheduleFollowUpFromDetail({ status: "lost", archived_at: null }), false);
  assert.equal(
    canScheduleFollowUpFromDetail({
      status: "contacted",
      archived_at: "2026-01-01T00:00:00.000Z",
    }),
    false,
  );
  assert.equal(canScheduleFollowUpFromDetail(activeLead), true);
});

test("complete follow-up requires an open follow-up", () => {
  assert.equal(canCompleteFollowUpFromDetail(activeLead), false);
  assert.equal(
    canCompleteFollowUpFromDetail({
      ...activeLead,
      follow_up_at: EXISTING_FOLLOW_UP,
    }),
    true,
  );
});

test("Phase 2.1 pipeline transitions remain unchanged", () => {
  assert.equal(
    isAllowedPipelineStatusTransition("contacted", "appointment_scheduled"),
    true,
  );
  assert.equal(isAllowedPipelineStatusTransition("won", "lost"), false);
});

test("Phase 2.2 contact tracking remains intact", () => {
  assert.equal(shouldSetLastContactedAt("new", "contacted", null), true);
  assert.equal(
    resolveLastContactedAtUpdate("contacted", "contacted", "2026-01-01T00:00:00.000Z"),
    undefined,
  );
});

test("Phase 2.3 inspection tracking remains intact", () => {
  assert.equal(requiresInspectionDateForPipelineStatus("appointment_scheduled"), true);
  assert.equal(requiresInspectionDateForPipelineStatus("contacted"), false);

  const plan = planInspectionScheduleFromDetail({
    currentStatus: "contacted",
    existingAppointmentAt: null,
    newAppointmentAt: EXISTING_FOLLOW_UP,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "appointment_scheduled");
});

test("Phase 2.4 estimate tracking remains intact", () => {
  const plan = planEstimateSendFromDetail({
    currentStatus: "appointment_scheduled",
    existingEstimateAmount: null,
    existingEstimateSentAt: null,
    formEstimateAmountRaw: "8500",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "estimate_sent");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.estimateActivity, "sent");
});

test("Phase 2.5 won/lost tracking remains intact", () => {
  assert.equal(canMarkLeadAsLost("estimate_sent"), true);
  assert.equal(canMarkLeadAsLost("won"), false);

  const wonPlan = planMarkLeadWon({
    currentStatus: "estimate_sent",
    existingEstimateAmount: 8500,
    formFinalJobAmountRaw: "",
  });

  assert.ok(!("error" in wonPlan));

  const lostPlan = planMarkLeadLost({
    currentStatus: "new",
    lostReasonRaw: "price",
    lostNotesRaw: "",
  });

  assert.ok(!("error" in lostPlan));
});
