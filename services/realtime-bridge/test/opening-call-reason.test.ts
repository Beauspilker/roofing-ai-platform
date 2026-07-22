import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  applyCallReasonCapture,
  isPendingCallReasonQuestion,
  isShortYesNoReasonAnswer,
  normalizeCallReasonFromSpeech,
  resolveCallReasonClarificationReply,
} from "../src/orchestrator/call-reason-handling.js";
import { extractExplicitCallerName } from "../src/orchestrator/field-validation.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+15551234567",
  called_phone: "+14027611540",
  status: "active",
  current_question: null,
  collected_fields: { pending_question: "reason_for_call" },
  transcript: [],
  attempt_count: 0,
  started_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  completed_at: null,
  expires_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

test("pending call_reason accepts I'm calling for roof damage without confirmation", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "I'm calling for roof damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.problem_description, "roof damage");
  assert.equal(fields.full_name, undefined);
  assert.doesNotMatch(outcome.replyText, /I heard .*Is that correct/i);
  assert.match(outcome.replyText, /first and last name/i);
  assert.equal(getNextRequiredField(fields), "full_name");
});

test("Hail damage resolves call reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
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
  assert.equal(fields.full_name, undefined);
  assert.equal(getNextRequiredField(fields), "full_name");
});

test("My roof is leaking resolves without echo confirmation", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My roof is leaking.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /I heard .*Is that correct/i);
  assert.match(outcome.replyText, /first and last name/i);
});

test("unclear call reason asks focused clarification without echoing transcript", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Uh.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /didn't quite catch what you're calling about/i);
  assert.doesNotMatch(outcome.replyText, /I heard .*Is that correct/i);
  assert.doesNotMatch(outcome.replyText, /Uh/i);
});

test("no during reason clarification does not store no as call reason", async () => {
  const capture = applyCallReasonCapture(
    { pending_question: "call_reason", call_reason_awaiting_clarification: true },
    "No.",
  );

  assert.equal(capture.resolved, false);
  assert.equal(capture.fields.problem_description, undefined);

  const reply = resolveCallReasonClarificationReply(capture.fields, "No.");
  assert.match(reply, /what can the roofing team help you with/i);
  assert.doesNotMatch(reply, /I heard no/i);
});

test("yes during reason clarification does not store yes as call reason", () => {
  const capture = applyCallReasonCapture({ pending_question: "call_reason" }, "Yes.");
  assert.equal(capture.resolved, false);
  assert.equal(capture.fields.problem_description, undefined);
  assert.equal(isShortYesNoReasonAnswer("Yes."), true);
});

test("resolved call reason cannot jump to callback phone while callerName is missing", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "I'm calling for roof damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /best number to reach you/i);
  assert.match(outcome.replyText, /first and last name/i);
});

test("Twilio caller ID availability does not skip callerName", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /first and last name/i);
  assert.doesNotMatch(outcome.replyText, /best number to reach you/i);
});

test("I'm calling for roof damage does not extract calling as caller name", () => {
  assert.equal(extractExplicitCallerName("I'm calling for roof damage."), null);
  assert.equal(normalizeCallReasonFromSpeech("I'm calling for roof damage."), "roof damage");
  assert.equal(isPendingCallReasonQuestion("reason_for_call"), true);
  assert.equal(isPendingCallReasonQuestion("call_reason"), true);
});
