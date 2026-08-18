import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canScheduleInspectionFromDetail,
  formatInspectionBookedSummary,
  formatInspectionUpdatedSummary,
  parseAppointmentAtInput,
  planInspectionScheduleFromDetail,
  planPipelineInspectionAdvance,
  requiresInspectionDateForPipelineStatus,
  resolveAppointmentAtForPipelineAdvance,
  resolveInspectionAppointmentActivity,
  shouldIncludeAppointmentAtInUpdate,
} from "./lead-inspection.js";
import {
  resolveLastContactedAtUpdate,
  shouldSetLastContactedAt,
} from "./leads.js";

const EXISTING_APPOINTMENT = "2026-02-10T18:00:00.000Z";
const NEW_APPOINTMENT = "2026-03-15T14:30:00.000Z";
const LOCAL_INPUT = "2026-03-15T09:30";

test("Contacted → Inspection scheduled with a valid inspection date", () => {
  const parsed = parseAppointmentAtInput(LOCAL_INPUT);
  assert.ok("appointmentAt" in parsed);

  const plan = planInspectionScheduleFromDetail({
    currentStatus: "contacted",
    existingAppointmentAt: null,
    newAppointmentAt: parsed.appointmentAt,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "appointment_scheduled");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.appointmentActivity, "booked");
  assert.equal(plan.appointmentAt, parsed.appointmentAt);
});

test("pipeline advance requires an inspection date when none exists", () => {
  const result = planPipelineInspectionAdvance({
    existingAppointmentAt: null,
    formAppointmentAtRaw: "",
  });

  assert.ok("error" in result);
  assert.match(result.error, /inspection date/i);
});

test("pipeline advance accepts a valid inspection date", () => {
  const parsed = parseAppointmentAtInput(LOCAL_INPUT);
  assert.ok("appointmentAt" in parsed);

  const plan = planPipelineInspectionAdvance({
    existingAppointmentAt: null,
    formAppointmentAtRaw: LOCAL_INPUT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "appointment_scheduled");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.appointmentActivity, "booked");
  assert.equal(plan.appointmentAt, parsed.appointmentAt);
});

test("pipeline advance reuses an existing inspection date", () => {
  const plan = planPipelineInspectionAdvance({
    existingAppointmentAt: EXISTING_APPOINTMENT,
    formAppointmentAtRaw: "",
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.appointmentAt, EXISTING_APPOINTMENT);
  assert.equal(plan.appointmentActivity, "none");
});

test("scheduling from the lead detail control advances Contacted leads", () => {
  const plan = planInspectionScheduleFromDetail({
    currentStatus: "contacted",
    existingAppointmentAt: null,
    newAppointmentAt: NEW_APPOINTMENT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "appointment_scheduled");
  assert.equal(plan.statusChanged, true);
  assert.equal(plan.appointmentActivity, "booked");
});

test("rescheduling an existing inspection does not change pipeline status", () => {
  const plan = planInspectionScheduleFromDetail({
    currentStatus: "appointment_scheduled",
    existingAppointmentAt: EXISTING_APPOINTMENT,
    newAppointmentAt: NEW_APPOINTMENT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.nextStatus, "appointment_scheduled");
  assert.equal(plan.statusChanged, false);
  assert.equal(plan.appointmentActivity, "updated");
});

test("saving the same inspection time does not create appointment activity", () => {
  const plan = planInspectionScheduleFromDetail({
    currentStatus: "appointment_scheduled",
    existingAppointmentAt: EXISTING_APPOINTMENT,
    newAppointmentAt: EXISTING_APPOINTMENT,
  });

  assert.ok(!("error" in plan));
  assert.equal(plan.statusChanged, false);
  assert.equal(plan.appointmentActivity, "none");
});

test("appointment_at persistence helpers detect unchanged values", () => {
  assert.equal(
    shouldIncludeAppointmentAtInUpdate(EXISTING_APPOINTMENT, EXISTING_APPOINTMENT),
    false,
  );
  assert.equal(
    shouldIncludeAppointmentAtInUpdate(null, NEW_APPOINTMENT),
    true,
  );
  assert.equal(
    shouldIncludeAppointmentAtInUpdate(EXISTING_APPOINTMENT, NEW_APPOINTMENT),
    true,
  );
});

test("resolveAppointmentAtForPipelineAdvance prefers a submitted date over existing", () => {
  const parsed = parseAppointmentAtInput(LOCAL_INPUT);
  assert.ok("appointmentAt" in parsed);

  const resolved = resolveAppointmentAtForPipelineAdvance(
    EXISTING_APPOINTMENT,
    LOCAL_INPUT,
  );

  assert.ok(!("error" in resolved));
  assert.equal(resolved.appointmentAt, parsed.appointmentAt);
});

test("activity summaries describe booked and updated inspections", () => {
  assert.match(
    formatInspectionBookedSummary(NEW_APPOINTMENT),
    /Inspection scheduled for/,
  );
  assert.match(
    formatInspectionUpdatedSummary(NEW_APPOINTMENT),
    /Inspection rescheduled to/,
  );
});

test("inspection activity kinds follow first schedule and reschedule rules", () => {
  assert.equal(
    resolveInspectionAppointmentActivity(null, NEW_APPOINTMENT),
    "booked",
  );
  assert.equal(
    resolveInspectionAppointmentActivity(EXISTING_APPOINTMENT, NEW_APPOINTMENT),
    "updated",
  );
  assert.equal(
    resolveInspectionAppointmentActivity(
      EXISTING_APPOINTMENT,
      EXISTING_APPOINTMENT,
    ),
    "none",
  );
});

test("requiresInspectionDateForPipelineStatus applies only to Inspection scheduled", () => {
  assert.equal(requiresInspectionDateForPipelineStatus("appointment_scheduled"), true);
  assert.equal(requiresInspectionDateForPipelineStatus("estimate_sent"), false);
  assert.equal(requiresInspectionDateForPipelineStatus("contacted"), false);
});

test("canScheduleInspectionFromDetail allows contacted and scheduled leads only", () => {
  assert.equal(canScheduleInspectionFromDetail("contacted"), true);
  assert.equal(canScheduleInspectionFromDetail("appointment_scheduled"), true);
  assert.equal(canScheduleInspectionFromDetail("new"), false);
  assert.equal(canScheduleInspectionFromDetail("estimate_sent"), false);
});

test("Phase 2.2 last_contacted_at remains intact for inspection transitions", () => {
  assert.equal(
    shouldSetLastContactedAt("contacted", "appointment_scheduled", null),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate("contacted", "appointment_scheduled", null),
    undefined,
  );
});
