import assert from "node:assert/strict";
import test from "node:test";

import {
  blockClosingPhraseForConversationState,
  containsClosingPhrase,
  AcknowledgmentPolicy,
} from "../src/orchestrator/acknowledgment-policy.js";
import {
  canCloseCall,
  canPresentSummary,
  blocksPrematureCallClosing,
  getMissingRequiredFields,
} from "../src/orchestrator/required-intake.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";
import { buildClosingMessage, isSummaryConfirmed } from "../src/orchestrator/realtime-prompts.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";

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

test("first caller response I'm calling about hail damage resolves reason and blocks closing", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "I'm calling about hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.match(fields.problem_description ?? "", /hail damage/i);
  assert.equal(fields.full_name, undefined);
  assert.equal(canCloseCall(fields, outcome.nextConversationState, "yes"), false);
  assert.equal(canPresentSummary(fields), false);
  assert.equal(outcome.hangup, false);
  assert.equal(outcome.hangupAfterMark, false);
  assert.match(outcome.replyText, /first and last name/i);
});

test("first caller response Roof damage does not close and selects caller_name", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Roof damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /Thanks for calling/i);
  assert.equal(outcome.nextConversationState, "collecting_intake");
  assert.match(outcome.replyText, /first and last name/i);
});

test("listening_for_reason cannot transition to delivering_closing on first answer", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "I'm calling about hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.notEqual(outcome.nextConversationState, "delivering_closing");
  assert.notEqual(outcome.nextConversationState, "completed");
  assert.equal(blocksPrematureCallClosing("listening_for_reason"), true);
});

test("collecting_intake cannot close without final summary confirmation", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main St",
    address_confirmed: true,
  };

  assert.equal(canPresentSummary(fields), false);
  assert.equal(canCloseCall(fields, "collecting_intake", "yes"), false);
});

test("missing required fields always block closing", () => {
  const fields: RealtimeFields = { problem_description: "hail damage" };

  assert.ok(getMissingRequiredFields(fields).length > 0);
  assert.equal(canPresentSummary(fields), false);
  assert.equal(canCloseCall(fields, "awaiting_summary_confirmation", "yes"), false);
});

test("malformed missing-field calculations cannot default to closing", () => {
  const fields = {} as RealtimeFields;
  const missing = getMissingRequiredFields(fields);

  assert.ok(Array.isArray(missing));
  assert.ok(missing.length > 0);
  assert.equal(canPresentSummary(fields), false);
  assert.equal(canCloseCall(fields, "awaiting_summary_confirmation", "yes"), false);
});

test("no-progress fallback asks for clarification instead of closing", async () => {
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
  assert.equal(outcome.hangup, false);
  assert.equal(outcome.nextConversationState, "listening_for_reason");
});

test("incomplete intake with yes confirmation cannot close the call", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { insurance_claim_started: false },
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Yes, that is correct",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.hangup, false);
  assert.equal(outcome.hangupAfterMark, false);
  assert.notEqual(outcome.nextConversationState, "delivering_closing");
  assert.notEqual(outcome.nextConversationState, "completed");
});

test("premature summary confirmation speech does not close the call", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { pending_question: "reason_for_call" },
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Yeah I'm calling about hail damage.",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.equal(isSummaryConfirmed("Yeah I'm calling about hail damage."), false);
  assert.equal(outcome.hangup, false);
  assert.equal(outcome.hangupAfterMark, false);
  assert.notEqual(outcome.nextConversationState, "delivering_closing");
});

test("Thanks for calling is blocked before delivering_closing", () => {
  assert.equal(
    blockClosingPhraseForConversationState(
      "collecting_intake",
      buildClosingMessage(),
    ),
    "",
  );
  assert.equal(
    blockClosingPhraseForConversationState(
      "delivering_closing",
      buildClosingMessage(),
    ),
    buildClosingMessage(),
  );
  assert.equal(containsClosingPhrase("Thanks for calling Beau's Roofing."), true);
});

test("complete intake with explicit summary confirmation may close", () => {
  const complete: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    adjuster_contacted: false,
    appointment_preference: "July 21 at 2:00 PM",
    schedule_confirmed: true,
    additional_notes_responded: true,
  };

  assert.equal(canPresentSummary(complete), true);
  assert.equal(canCloseCall(complete, "awaiting_summary_confirmation", "Yes, that's correct"), true);
});
