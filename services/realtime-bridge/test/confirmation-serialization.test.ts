import assert from "node:assert/strict";
import test from "node:test";

import { ResponseSerializer } from "../src/bridge/response-serializer.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  isAtomicPhoneConfirmationReply,
  resolveConfirmationResponseReason,
} from "../src/orchestrator/confirmation-response-routing.js";
import { buildPhoneConfirmationReply } from "../src/orchestrator/confirmation-builders.js";
import { buildIntakeReply } from "../src/orchestrator/realtime-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+14025550187",
  called_phone: "+14027611540",
  status: "active",
  current_question: null,
  collected_fields: {},
  transcript: [],
  attempt_count: 0,
  started_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  completed_at: null,
  expires_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

test("callback confirmation is one atomic utterance with number before question", () => {
  const reply = buildPhoneConfirmationReply({
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
  });

  assert.equal(isAtomicPhoneConfirmationReply(reply), true);
  assert.match(reply, /^Just to confirm, your callback number is 402-555-0187\. Is that correct\?$/i);
});

test("resolveConfirmationResponseReason maps atomic phone confirmation", () => {
  const reply =
    "Just to confirm, your callback number is 402-555-0187. Is that correct?";

  assert.equal(resolveConfirmationResponseReason(reply), "phone_confirmation");
});

test("buildIntakeReply returns atomic callback confirmation when readback is pending", () => {
  const fields: RealtimeFields = {
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
    pending_question: "callback_confirmation",
  };

  const reply = buildIntakeReply(new AcknowledgmentPolicy(), fields, "yes", "+14025550187", 1);

  assert.equal(isAtomicPhoneConfirmationReply(reply), true);
  assert.doesNotMatch(reply, /best number to reach you/i);
});

test("callback readback is offered without requiring caller name first", async () => {
  const fields: RealtimeFields = {
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
    problem_description: "roof leak",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "The leak is getting worse.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.equal(outcome.nextConversationState, "awaiting_callback_confirmation");
  assert.equal(isAtomicPhoneConfirmationReply(outcome.replyText), true);
});

test("overlapping response requests are blocked by serializer", () => {
  const serializer = new ResponseSerializer();

  serializer.beginResponse("phone_confirmation");

  const plan = serializer.planResponse(
    "caller_turn_reply",
    "What is your address?",
    true,
  );

  assert.equal(plan.disposition, "queued");
  assert.equal(serializer.getActiveReason(), "phone_confirmation");
});

test("duplicate response purpose is deduplicated", () => {
  const serializer = new ResponseSerializer();

  serializer.beginResponse("phone_confirmation");

  const plan = serializer.planResponse(
    "phone_confirmation",
    "Just to confirm, your callback number is 402-555-0187. Is that correct?",
    true,
  );

  assert.equal(plan.disposition, "deduplicated");
});

test("different response purposes remain correctly ordered via queue", () => {
  const serializer = new ResponseSerializer();

  serializer.beginResponse("phone_confirmation");
  serializer.planResponse("caller_turn_reply", "Thanks. What is your address?", true);

  serializer.endResponse();
  const next = serializer.consumeQueuedResponse();

  assert.deepEqual(next, {
    reason: "caller_turn_reply",
    text: "Thanks. What is your address?",
  });
});

test("confirmation response blocks caller turn processing while active", () => {
  const guard = new ResponseStateGuard();
  const serializer = new ResponseSerializer();

  serializer.beginResponse("phone_confirmation");
  guard.recordTrigger("phone_confirmation");

  assert.equal(guard.canProcessCallerTurnWhileActive("awaiting_callback_confirmation"), false);
  assert.equal(serializer.shouldBlockCallerTurnWhileActive(), true);
  assert.equal(serializer.isConfirmationActive(), true);
});

test("correction still works after atomic phone confirmation", async () => {
  const fields: RealtimeFields = {
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
    pending_question: "callback_confirmation",
    field_being_confirmed: "callback_phone",
    confirmation_candidate: "+14025550187",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "No, use 402-555-0199 instead.",
    conversationState: "awaiting_callback_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.notEqual(outcome.replyText.trim(), "");
  assert.match(outcome.replyText, /402-555-0199|555-0199/i);
});
