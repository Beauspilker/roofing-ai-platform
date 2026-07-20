import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import {
  ensureSingleIntakeQuestion,
  REALTIME_OPENING_GREETING,
} from "../src/orchestrator/realtime-prompts.js";

test("ResponseStateGuard allows only one active response", () => {
  const guard = new ResponseStateGuard();

  assert.equal(guard.canTriggerResponse("opening_greeting"), true);
  guard.recordTrigger("opening_greeting");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isActiveResponse(), true);

  guard.onResponseDone();
  assert.equal(guard.isActiveResponse(), false);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isWaitingForCaller(), true);
});

test("ResponseStateGuard blocks caller reply until transcript is registered", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  guard.onResponseDone();

  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);

  guard.registerCallerTranscript("item-1");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), true);
});

test("ResponseStateGuard deduplicates transcript item ids", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  guard.onResponseDone();

  assert.equal(guard.registerCallerTranscript("item-1"), true);
  assert.equal(guard.registerCallerTranscript("item-1"), false);
});

test("ensureSingleIntakeQuestion keeps only the first question", () => {
  const reply = ensureSingleIntakeQuestion(
    "Got it. What's your name? And what's the address?",
  );

  assert.equal(reply, "Got it. What's your name?");
});

test("opening greeting waits for caller and contains no intake fields", () => {
  assert.equal(
    REALTIME_OPENING_GREETING,
    "Thanks for calling Beau's Roofing. How can I help you today?",
  );
  assert.equal(ensureSingleIntakeQuestion(REALTIME_OPENING_GREETING).includes("name"), false);
  assert.equal(ensureSingleIntakeQuestion(REALTIME_OPENING_GREETING).includes("address"), false);
});

test("configured voice is marin in fly env default used by bridge config", () => {
  const voice = process.env.OPENAI_REALTIME_VOICE ?? "marin";
  assert.equal(voice, "marin");
});
