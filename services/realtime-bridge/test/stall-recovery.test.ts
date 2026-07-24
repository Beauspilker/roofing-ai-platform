import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_COMPLETION_STALL_MS,
  EXTRACTION_STALL_MS,
  MAX_STALL_RECOVERY_ATTEMPTS,
  STALL_RECOVERY_PROMPT,
  StallRecoveryController,
  buildStallRecoveryReply,
} from "../src/bridge/stall-recovery.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

test("extraction stall fires after configured timeout", async () => {
  const controller = new StallRecoveryController();
  let category: string | null = null;

  controller.beginExtractionWatch(1, (detected) => {
    category = detected;
  });

  await new Promise((resolve) => setTimeout(resolve, EXTRACTION_STALL_MS + 50));
  assert.equal(category, "transcript_extraction_stalled");
});

test("recovery attempts are capped", () => {
  const controller = new StallRecoveryController();

  assert.equal(controller.canAttemptRecovery(), true);
  controller.recordRecoveryAttempt();
  controller.recordRecoveryAttempt();
  controller.recordRecoveryAttempt();
  assert.equal(controller.canAttemptRecovery(), false);
  assert.equal(controller.getRecoveryAttempts(), MAX_STALL_RECOVERY_ATTEMPTS);
});

test("recovery reply resumes from next missing field without repeating captured data", () => {
  const fields: RealtimeFields = {
    full_name: "Beau Spilker",
    caller_first_name: "Beau",
    caller_last_name: "Spilker",
    opening_name_complete: true,
    problem_description: "hail damage",
    insurance_claim_started: false,
    field_resolution: {
      insurance_claim_started: "captured",
    },
  };

  const reply = buildStallRecoveryReply(fields, "+15551234567", 1);
  assert.match(reply, new RegExp(STALL_RECOVERY_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(reply, /first and last name/i);
  assert.doesNotMatch(reply, /insurance claim/i);
  assert.match(reply, /best number|callback|urgent|address|leak/i);
});

test("stall timeout constants match realtime flow expectations", () => {
  assert.equal(EXTRACTION_STALL_MS, 5_000);
  assert.equal(AUDIO_COMPLETION_STALL_MS, 15_000);
});
