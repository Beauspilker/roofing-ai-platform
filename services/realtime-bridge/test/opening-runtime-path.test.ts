import assert from "node:assert/strict";
import test from "node:test";

import { OpeningSilenceController } from "../src/bridge/opening-listening.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  applyCallReasonCapture,
  blocksGenericReadbackConfirmation,
  buildCallReasonResolvedReply,
  isPendingCallReasonQuestion,
} from "../src/orchestrator/call-reason-handling.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+15551234567",
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

function sessionWithPendingReason(): typeof mockSession {
  return {
    ...mockSession,
    collected_fields: { pending_question: "reason_for_call" },
  };
}

test("greeting response.done enters listening_for_reason without selecting caller_name", () => {
  const orchestrator = new SessionOrchestrator({
    callSid: "CA123",
    callerPhone: "+15551234567",
    calledPhone: "+14027611540",
  });

  (orchestrator as unknown as { session: typeof mockSession }).session = {
    ...mockSession,
  };

  orchestrator.markOpeningDelivered();
  orchestrator.onOpeningGreetingComplete();

  assert.equal(orchestrator.getConversationState(), "listening_for_reason");
  assert.equal(orchestrator.isOpeningGreetingPlaybackComplete(), true);

  const fields = (orchestrator.getSession()?.collected_fields ?? {}) as RealtimeFields;
  assert.equal(fields.pending_question, "reason_for_call");
  assert.equal(resolvePendingQuestion(fields, "listening_for_reason"), "reason_for_call");
  assert.equal(getNextRequiredField(fields), "problem_description");
});

test("greeting response.done blocks caller_turn_reply response.create", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  guard.onResponseDone();

  assert.equal(guard.isListeningForOpeningReason(), true);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
});

test("caller remains silent for one second after greeting creates no intake reply", async () => {
  const controller = new OpeningSilenceController();
  const prompts: string[] = [];

  controller.beginListeningForReason();
  controller.scheduleSilenceCheck((prompt) => {
    prompts.push(prompt);
  });

  assert.equal(prompts.length, 0);
  controller.clearSilenceTimer();

  const orchestrator = new SessionOrchestrator({
    callSid: "CA123",
    callerPhone: "+15551234567",
    calledPhone: "+14027611540",
  });

  (orchestrator as unknown as { session: typeof mockSession }).session = {
    ...sessionWithPendingReason(),
  };
  orchestrator.onOpeningGreetingComplete();

  const ignored = await orchestrator.handleCallerTranscript("");
  assert.equal(ignored, null);
});

test("I'm calling about roof damage resolves reason and selects caller_name once", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: sessionWithPendingReason(),
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "I'm calling about roof damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.problem_description, "roof damage");
  assert.equal(fields.pending_question, "caller_name");
  assert.doesNotMatch(outcome.replyText, /I heard .*Is that correct/i);
  assert.match(outcome.replyText, /Could I start with your name/i);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.equal(outcome.nextConversationState, "collecting_intake");
});

test("Hail damage resolves reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: sessionWithPendingReason(),
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.match(fields.problem_description ?? "", /hail damage/i);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.match(outcome.replyText, /Could I start with your name/i);
});

test("no while reason_for_call is pending is not stored as reason", async () => {
  const capture = applyCallReasonCapture(
    { pending_question: "reason_for_call", call_reason_awaiting_clarification: true },
    "No.",
  );

  assert.equal(capture.resolved, false);
  assert.equal(capture.fields.problem_description, undefined);
  assert.equal(blocksGenericReadbackConfirmation(capture.fields, "listening_for_reason"), true);

  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...sessionWithPendingReason(),
      collected_fields: capture.fields,
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /I heard no/i);
  assert.equal(outcome.nextConversationState, "listening_for_reason");
});

test("generic readback handler is blocked for reason_for_call", () => {
  const fields: RealtimeFields = { pending_question: "reason_for_call" };

  assert.equal(blocksGenericReadbackConfirmation(fields, "listening_for_reason"), true);
  assert.equal(isPendingCallReasonQuestion("reason_for_call"), true);
  assert.equal(isPendingCallReasonQuestion("call_reason"), true);
});

test("Twilio caller ID availability does not skip callerName after reason resolved", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: sessionWithPendingReason(),
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /Could I start with your name/i);
  assert.doesNotMatch(outcome.replyText, /best number to reach you/i);
});

test("buildCallReasonResolvedReply produces one deterministic caller_name response", () => {
  const post = buildCallReasonResolvedReply({
    problem_description: "roof damage",
    pending_question: undefined,
  });

  assert.match(post.replyText, /Could I start with your name/i);
  assert.equal(post.fields.pending_question, "caller_name");
  assert.equal(post.nextState, "collecting_intake");
});

test("listening_for_reason without meaningful transcript does not advance intake", async () => {
  const orchestrator = new SessionOrchestrator({
    callSid: "CA123",
    callerPhone: "+15551234567",
    calledPhone: "+14027611540",
  });

  (orchestrator as unknown as { session: typeof mockSession }).session = {
    ...sessionWithPendingReason(),
  };
  orchestrator.onOpeningGreetingComplete();

  const ignored = await orchestrator.handleCallerTranscript("hello");
  assert.equal(ignored, null);
  assert.equal(orchestrator.getConversationState(), "listening_for_reason");
});
