import assert from "node:assert/strict";
import test from "node:test";

import {
  GreetingReadinessGate,
  GreetingWatchdog,
} from "../src/bridge/opening-pipeline.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";

test("greeting is requested only after twilio, openai, session, and orchestrator are ready", () => {
  const gate = new GreetingReadinessGate();

  assert.equal(gate.canRequestGreeting(), false);

  gate.markTwilioStreamReady("CA1");
  assert.equal(gate.canRequestGreeting(), false);

  gate.markOpenAiReady("CA1");
  assert.equal(gate.canRequestGreeting(), false);

  gate.markSessionConfigured("CA1");
  assert.equal(gate.canRequestGreeting(), false);

  gate.markOrchestratorInitialized("CA1");
  assert.equal(gate.canRequestGreeting(), true);
});

test("greeting is requested exactly once per call", () => {
  const gate = new GreetingReadinessGate();

  gate.markTwilioStreamReady("CA1");
  gate.markOpenAiReady("CA1");
  gate.markSessionConfigured("CA1");
  gate.markOrchestratorInitialized("CA1");

  assert.equal(gate.markGreetingRequested("CA1"), true);
  assert.equal(gate.canRequestGreeting(), false);
  assert.equal(gate.markGreetingRequested("CA1"), false);
});

test("early initialization cannot mark greeting requested before readiness", () => {
  const gate = new GreetingReadinessGate();

  gate.markOpenAiReady("CA1");
  assert.equal(gate.markGreetingRequested("CA1"), false);
  assert.equal(gate.hasGreetingBeenRequested(), false);
});

test("no-audio greeting allows one retry then blocks further retries", () => {
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
  assert.equal(gate.canRequestGreeting(), true);
});

test("successful first audio cancels greeting watchdog", () => {
  const watchdog = new GreetingWatchdog();
  let stalled = false;

  watchdog.onGreetingRequested("CA1");
  watchdog.schedule(() => {
    stalled = true;
  }, 50);

  watchdog.onFirstAudioForwarded("CA1");
  assert.equal(watchdog.hasFirstAudioForwarded(), true);

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(stalled, false);
      resolve();
    }, 80);
  });
});

test("greeting watchdog fires when first audio never reaches twilio", () => {
  const watchdog = new GreetingWatchdog();
  let stalledStage: string | null = null;

  watchdog.onGreetingRequested("CA1");
  watchdog.onResponseCreated("CA1");
  watchdog.schedule((stage) => {
    stalledStage = stage;
  }, 30);

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(stalledStage, "created");
      resolve();
    }, 60);
  });
});

test("second greeting failure cannot loop indefinitely", () => {
  const gate = new GreetingReadinessGate();

  gate.markTwilioStreamReady("CA1");
  gate.markOpenAiReady("CA1");
  gate.markSessionConfigured("CA1");
  gate.markOrchestratorInitialized("CA1");
  gate.markGreetingRequested("CA1");
  gate.markGreetingRetryUsed("CA1");

  assert.equal(gate.canRetryGreeting(), false);
});

test("greeting retry preserves readiness without requiring full call setup", () => {
  const gate = new GreetingReadinessGate();

  gate.markTwilioStreamReady("CA1");
  gate.markOpenAiReady("CA1");
  gate.markSessionConfigured("CA1");
  gate.markOrchestratorInitialized("CA1");
  gate.markGreetingRequested("CA1");

  gate.resetGreetingRequestForRetry("CA1");
  assert.equal(gate.isReady(), true);
  assert.equal(gate.markGreetingRequested("CA1"), true);
});

test("active opening greeting blocks duplicate caller_turn_reply triggers", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.canTriggerResponse("opening_greeting"), false);
});
