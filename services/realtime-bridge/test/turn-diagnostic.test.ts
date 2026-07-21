import assert from "node:assert/strict";
import test from "node:test";

import {
  diffTrackedFields,
  explainPostIntakeBranch,
  isTurnDiagnosticsEnabled,
  snapshotTurnState,
} from "../src/bridge/turn-diagnostic.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

test("turn diagnostics can be disabled explicitly", () => {
  const previous = process.env.REALTIME_TURN_DIAGNOSTICS;
  process.env.REALTIME_TURN_DIAGNOSTICS = "false";

  try {
    assert.equal(isTurnDiagnosticsEnabled(), false);
  } finally {
    process.env.REALTIME_TURN_DIAGNOSTICS = previous;
  }
});

test("snapshotTurnState tracks callback confirmation flag", () => {
  const snapshot = snapshotTurnState(
    {
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
      pending_question: "insurance_claim",
    },
    "collecting_intake",
  );

  assert.equal(snapshot.callbackPhoneConfirmed, true);
  assert.equal(snapshot.pendingQuestion, "insurance_claim");
});

test("diffTrackedFields reports callback confirmation loss", () => {
  const before: RealtimeFields = {
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
  };
  const after: RealtimeFields = {
    callback_phone: "+14025551234",
    callback_phone_confirmed: false,
  };

  const diff = diffTrackedFields(before, after);
  assert.deepEqual(diff, [
    {
      field: "callback_phone_confirmed",
      before: true,
      after: false,
      accepted: true,
    },
  ]);
});

test("explainPostIntakeBranch identifies callback readback branch", () => {
  const branch = explainPostIntakeBranch(
    {
      problem_description: "hail damage",
      full_name: "Beau Spilker",
      callback_phone: "+14025551234",
      callback_phone_confirmed: false,
    },
    {},
  );

  assert.equal(branch.action, "callback_confirmation_readback");
});
