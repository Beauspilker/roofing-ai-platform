import assert from "node:assert/strict";
import test from "node:test";

import {
  CallAudioDiagnostics,
  detectTwilioSequenceGap,
  parseTwilioSequenceNumber,
} from "../src/bridge/audio-diagnostics.js";

test("detectTwilioSequenceGap flags skipped media sequence numbers", () => {
  assert.equal(detectTwilioSequenceGap(10, 12), 2);
  assert.equal(detectTwilioSequenceGap(10, 11), null);
  assert.equal(detectTwilioSequenceGap(null, 5), null);
});

test("parseTwilioSequenceNumber parses numeric sequence values", () => {
  assert.equal(parseTwilioSequenceNumber("42"), 42);
  assert.equal(parseTwilioSequenceNumber(undefined), null);
});

test("CallAudioDiagnostics records media without changing external state", () => {
  const diagnostics = new CallAudioDiagnostics();
  diagnostics.beginCall("CA_TEST_123");
  diagnostics.recordTwilioInboundMedia({
    sequenceNumber: "1",
    payloadBytes: 160,
  });
  diagnostics.recordTwilioInboundMedia({
    sequenceNumber: "4",
    payloadBytes: 160,
  });
  diagnostics.recordTwilioOutboundMedia(320);
  diagnostics.recordDiscardedOpenAiDelta(2, "stale_response_turn");
  diagnostics.recordBargeIn(2);

  const snapshot = diagnostics.getSnapshotForTests();
  assert.equal(snapshot.twilioInboundFrames, 2);
  assert.equal(snapshot.twilioOutboundFrames, 1);
  assert.equal(snapshot.discardedDeltaCount, 1);
  assert.equal(snapshot.bargeInCount, 1);

  diagnostics.endCall("test_complete");
});

test("CallAudioDiagnostics does not expose conversation mutation hooks", () => {
  const diagnostics = new CallAudioDiagnostics();
  const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(diagnostics)).sort();
  assert.equal(keys.includes("setConversationState"), false);
  assert.equal(keys.includes("advanceIntake"), false);
});
