import assert from "node:assert/strict";
import test from "node:test";

import { GreetingAudioBuffer } from "../src/bridge/greeting-audio-buffer.js";
import {
  GreetingDeliveryTracker,
  GreetingReadinessGate,
  GreetingWatchdog,
  resolveGreetingRootCause,
} from "../src/bridge/opening-pipeline.js";

test("resolveGreetingRootCause maps requested stage to RESPONSE_CREATE_TIMEOUT", () => {
  const tracker = new GreetingDeliveryTracker();
  tracker.markRequestSent("CA1");

  assert.equal(resolveGreetingRootCause("requested", tracker), "RESPONSE_CREATE_TIMEOUT");
});

test("resolveGreetingRootCause maps created stage to FIRST_AUDIO_TIMEOUT", () => {
  const tracker = new GreetingDeliveryTracker();
  tracker.markRequestSent("CA1");
  tracker.markResponseCreated("CA1");

  assert.equal(resolveGreetingRootCause("created", tracker), "FIRST_AUDIO_TIMEOUT");
});

test("resolveGreetingRootCause maps first_audio_received stage to TWILIO_FORWARD_BLOCKED", () => {
  const tracker = new GreetingDeliveryTracker();
  tracker.markRequestSent("CA1");
  tracker.markResponseCreated("CA1");
  tracker.markFirstAudioReceived("CA1");

  assert.equal(
    resolveGreetingRootCause("first_audio_received", tracker),
    "TWILIO_FORWARD_BLOCKED",
  );
});

test("watchdog is cancelled only after first audio is forwarded", async () => {
  const watchdog = new GreetingWatchdog();
  let stalled = false;

  watchdog.onGreetingRequested("CA1");
  watchdog.onResponseCreated("CA1");
  watchdog.onFirstAudioDelta("CA1");
  watchdog.schedule(() => {
    stalled = true;
  }, 40);

  assert.equal(watchdog.hasFirstAudioReceived(), true);
  assert.equal(watchdog.hasFirstAudioForwarded(), false);

  watchdog.onFirstAudioForwarded("CA1");
  assert.equal(watchdog.hasFirstAudioForwarded(), true);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stalled, false);
});

test("greeting audio buffer flushes once forwarding becomes ready", () => {
  const buffer = new GreetingAudioBuffer();
  const forwarded: string[] = [];

  assert.equal(buffer.enqueue("chunk-a"), true);
  assert.equal(buffer.enqueue("chunk-b"), true);
  assert.equal(buffer.hasBufferedAudio(), true);

  const flushed = buffer.flush((chunk) => {
    forwarded.push(chunk);
  });

  assert.equal(flushed, 2);
  assert.deepEqual(forwarded, ["chunk-a", "chunk-b"]);
  assert.equal(buffer.hasBufferedAudio(), false);
});

test("greeting delivery tracker distinguishes request sent from audio forwarded", () => {
  const tracker = new GreetingDeliveryTracker();

  tracker.markRequestSent("CA1");
  assert.equal(tracker.greetingRequestSent, true);
  assert.equal(tracker.greetingFirstAudioForwarded, false);

  tracker.markResponseCreated("CA1");
  tracker.markFirstAudioReceived("CA1");
  tracker.markFirstAudioForwarded("CA1");

  assert.equal(tracker.greetingResponseCreated, true);
  assert.equal(tracker.greetingFirstAudioForwarded, true);
});

test("first greeting failure allows exactly one retry via readiness gate", () => {
  const gate = new GreetingReadinessGate();

  gate.markTwilioStreamReady("CA1");
  gate.markOpenAiReady("CA1");
  gate.markSessionConfigured("CA1");
  gate.markOrchestratorInitialized("CA1");
  gate.markGreetingRequested("CA1");

  assert.equal(gate.canRetryGreeting(), true);
  gate.markGreetingRetryUsed("CA1");
  gate.resetGreetingRequestForRetry("CA1");
  assert.equal(gate.canRetryGreeting(), false);
});

test("fallback unavailable is tracked when fallback cannot be produced", () => {
  const tracker = new GreetingDeliveryTracker();

  tracker.markFallbackRequested("CA1");
  tracker.markFallbackUnavailable("CA1");

  assert.equal(tracker.fallbackRequested, true);
  assert.equal(tracker.fallbackUnavailable, true);
  assert.equal(tracker.lastRootCause, "FALLBACK_UNAVAILABLE");
});
