import assert from "node:assert/strict";
import test from "node:test";

import { BargeInController } from "../src/bridge/barge-in.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";

test("barge-in cancels active response and clears assistant speaking state", () => {
  const openAiEvents: Record<string, unknown>[] = [];
  const twilioMessages: Record<string, unknown>[] = [];
  let assistantSpeaking = false;
  let bargeInFired = false;

  const controller = new BargeInController({
    enabled: true,
    sendOpenAiEvent: (payload) => {
      openAiEvents.push(payload);
    },
    sendTwilioMessage: (payload) => {
      twilioMessages.push(payload);
    },
    getStreamSid: () => "MZ123",
    getPlayedDurationMs: () => 1200,
    getActiveResponseId: () => "resp_1",
    getActiveItemId: () => "item_1",
    onAssistantSpeakingChange: (speaking) => {
      assistantSpeaking = speaking;
    },
    onBargeIn: () => {
      bargeInFired = true;
    },
  });

  controller.handleResponseStarted("resp_1", "item_1");
  assert.equal(assistantSpeaking, true);

  controller.handleCallerSpeechStarted();

  assert.equal(bargeInFired, true);
  assert.equal(openAiEvents.some((event) => event.type === "response.cancel"), true);
  assert.equal(
    openAiEvents.some((event) => event.type === "conversation.item.truncate"),
    true,
  );
  assert.equal(twilioMessages.some((message) => message.event === "clear"), true);
  assert.equal(assistantSpeaking, false);
});

test("duplicate caller turn reply blocked while active response is speaking", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isActiveResponse(), true);

  guard.onResponseCancelled();
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);

  guard.prepareCallerTurnRecovery();
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), true);
});

test("barge-in does not trigger when assistant is not speaking", () => {
  let bargeInCount = 0;
  const controller = new BargeInController({
    enabled: true,
    sendOpenAiEvent: () => {
      bargeInCount += 1;
    },
    sendTwilioMessage: () => {},
    getStreamSid: () => "MZ123",
    getPlayedDurationMs: () => 0,
    getActiveResponseId: () => null,
    getActiveItemId: () => null,
    onAssistantSpeakingChange: () => {},
  });

  controller.handleCallerSpeechStarted();
  assert.equal(bargeInCount, 0);
});
