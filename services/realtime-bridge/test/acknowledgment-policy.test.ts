import assert from "node:assert/strict";
import test from "node:test";

import {
  AcknowledgmentPolicy,
  shouldUseSafetyAcknowledgment,
} from "../src/orchestrator/acknowledgment-policy.js";

test("hail damage does not warrant safety acknowledgment", () => {
  assert.equal(shouldUseSafetyAcknowledgment("We had hail damage last night."), false);
});

test("roof leak without personal safety does not warrant safety acknowledgment", () => {
  assert.equal(
    shouldUseSafetyAcknowledgment("Water is coming into the kitchen from the roof leak."),
    false,
  );
});

test("tree damage does not warrant safety acknowledgment", () => {
  assert.equal(
    shouldUseSafetyAcknowledgment("A tree fell on the roof and damaged some shingles."),
    false,
  );
});

test("everyone is safe warrants safety acknowledgment", () => {
  assert.equal(shouldUseSafetyAcknowledgment("Everyone is safe, but the roof is bad."), true);
});

test("injuries mentioned warrant safety acknowledgment", () => {
  assert.equal(shouldUseSafetyAcknowledgment("No injuries, everyone is okay."), true);
});

test("ordinary damage answer does not prepend glad everyone is safe", () => {
  const policy = new AcknowledgmentPolicy();
  const ack = policy.selectAcknowledgment({
    answer: "We had hail damage and a roof leak.",
    filledCount: 1,
    nextField: "callback_phone",
    isEmergency: true,
    afterConfirmation: true,
  });

  assert.notEqual(ack, "I'm glad everyone is safe.");
});

test("personal safety mention prepends glad everyone is safe once", () => {
  const policy = new AcknowledgmentPolicy();
  const ack = policy.selectAcknowledgment({
    answer: "Everyone is safe, but water is pouring in.",
    filledCount: 1,
    nextField: "callback_phone",
    isEmergency: true,
    afterConfirmation: true,
  });

  assert.equal(ack, "I'm glad everyone is safe.");
});

test("emergency_or_active_leak pool does not include glad everyone is safe", () => {
  const policy = new AcknowledgmentPolicy();
  const ack = policy.selectAcknowledgment({
    answer: "No active leak right now.",
    filledCount: 1,
    nextField: "emergency_or_active_leak",
    afterConfirmation: true,
  });

  assert.notEqual(ack, "I'm glad everyone is safe.");
});
