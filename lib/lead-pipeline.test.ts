import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canMarkLeadAsLost,
  formatStatusChangeSummary,
  getNextPipelineStatus,
  getPipelineStageIndex,
  isActionablePipelineStage,
  isAllowedPipelineStatusTransition,
  isPipelineTerminalStatus,
} from "./lead-pipeline.js";

test("getNextPipelineStatus follows the sales pipeline order", () => {
  assert.equal(getNextPipelineStatus("new"), "contacted");
  assert.equal(getNextPipelineStatus("contacted"), "appointment_scheduled");
  assert.equal(getNextPipelineStatus("appointment_scheduled"), "estimate_sent");
  assert.equal(getNextPipelineStatus("estimate_sent"), "won");
  assert.equal(getNextPipelineStatus("won"), null);
  assert.equal(getNextPipelineStatus("lost"), null);
});

test("isAllowedPipelineStatusTransition allows only the next stage or lost", () => {
  assert.equal(isAllowedPipelineStatusTransition("new", "contacted"), true);
  assert.equal(
    isAllowedPipelineStatusTransition("contacted", "appointment_scheduled"),
    true,
  );
  assert.equal(
    isAllowedPipelineStatusTransition("appointment_scheduled", "estimate_sent"),
    true,
  );
  assert.equal(
    isAllowedPipelineStatusTransition("estimate_sent", "won"),
    true,
  );
  assert.equal(isAllowedPipelineStatusTransition("new", "lost"), true);
  assert.equal(
    isAllowedPipelineStatusTransition("estimate_sent", "lost"),
    true,
  );

  assert.equal(isAllowedPipelineStatusTransition("new", "won"), false);
  assert.equal(isAllowedPipelineStatusTransition("new", "new"), false);
  assert.equal(isAllowedPipelineStatusTransition("won", "lost"), false);
  assert.equal(isAllowedPipelineStatusTransition("lost", "contacted"), false);
});

test("canMarkLeadAsLost excludes terminal and archived stages", () => {
  assert.equal(canMarkLeadAsLost("new"), true);
  assert.equal(canMarkLeadAsLost("estimate_sent"), true);
  assert.equal(canMarkLeadAsLost("won"), false);
  assert.equal(canMarkLeadAsLost("lost"), false);
  assert.equal(canMarkLeadAsLost("archived"), false);
});

test("formatStatusChangeSummary uses roofer-facing stage labels", () => {
  assert.equal(
    formatStatusChangeSummary("new", "contacted"),
    "Status changed: New → Contacted",
  );
  assert.equal(
    formatStatusChangeSummary("contacted", "appointment_scheduled"),
    "Status changed: Contacted → Inspection scheduled",
  );
});

test("getPipelineStageIndex maps known pipeline stages", () => {
  assert.equal(getPipelineStageIndex("new"), 0);
  assert.equal(getPipelineStageIndex("won"), 4);
  assert.equal(getPipelineStageIndex("lost"), -1);
});

test("isPipelineTerminalStatus identifies closed pipeline outcomes", () => {
  assert.equal(isPipelineTerminalStatus("won"), true);
  assert.equal(isPipelineTerminalStatus("lost"), true);
  assert.equal(isPipelineTerminalStatus("archived"), true);
  assert.equal(isPipelineTerminalStatus("contacted"), false);
});

test("isActionablePipelineStage enables only the next forward stage", () => {
  assert.equal(isActionablePipelineStage("new", "contacted"), true);
  assert.equal(isActionablePipelineStage("new", "appointment_scheduled"), false);
  assert.equal(
    isActionablePipelineStage("contacted", "appointment_scheduled"),
    true,
  );
  assert.equal(
    isActionablePipelineStage("appointment_scheduled", "estimate_sent"),
    true,
  );
  assert.equal(isActionablePipelineStage("estimate_sent", "won"), true);
  assert.equal(isActionablePipelineStage("estimate_sent", "lost"), false);
  assert.equal(isActionablePipelineStage("won", "lost"), false);
  assert.equal(isActionablePipelineStage("lost", "contacted"), false);
});
