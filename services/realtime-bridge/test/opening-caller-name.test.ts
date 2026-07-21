import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  extractAllFieldsFromTranscript,
  isShortPendingStyleAnswer,
} from "../src/orchestrator/multi-field-extraction.js";
import {
  isPlausibleCallerName,
  sanitizeInvalidStoredCallerName,
  validateCallerNameCandidate,
} from "../src/orchestrator/field-validation.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
import {
  getNextRequiredField,
  isCallerNameResolved,
} from "../src/orchestrator/required-intake.js";
import {
  mergeRealtimeCallerAnswer,
} from "../src/orchestrator/realtime-intake.js";
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

test("opening response Hail damage captures reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Hail damage.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.match(fields.problem_description ?? "", /hail damage/i);
  assert.equal(fields.full_name, undefined);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.equal(resolvePendingQuestion(fields, "collecting_intake"), "caller_name");
  assert.match(outcome.replyText, /Could I start with your name/i);
});

test("opening response My roof is leaking captures reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My roof is leaking.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.match(fields.problem_description ?? "", /roof.*leak/i);
  assert.equal(fields.full_name, undefined);
  assert.equal(getNextRequiredField(fields), "full_name");
});

test("opening response with volunteered name does not ask again", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My name is Beau and we have hail damage.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, "Beau");
  assert.match(fields.problem_description ?? "", /hail damage/i);
  assert.doesNotMatch(outcome.replyText, /Could I start with your name/i);
});

test("opening response This is Beau with tree damage stores both fields", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "This is Beau. A tree fell on my roof.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, "Beau");
  assert.match(fields.problem_description ?? "", /tree fell on my roof/i);
});

test("hail damage and roof leak cannot pass caller-name validation", () => {
  assert.equal(isPlausibleCallerName("hail damage"), false);
  assert.equal(isPlausibleCallerName("roof leak"), false);
  assert.equal(validateCallerNameCandidate("hail damage", { isDirectNameAnswer: true }).value, null);
  assert.equal(validateCallerNameCandidate("roof leak", { isDirectNameAnswer: true }).value, null);
});

test("phone numbers dates addresses and yes/no cannot populate callerName", () => {
  assert.equal(isPlausibleCallerName("4025550198"), false);
  assert.equal(isPlausibleCallerName("123 Main Street"), false);
  assert.equal(isPlausibleCallerName("tomorrow"), false);
  assert.equal(isPlausibleCallerName("yes"), false);
  assert.equal(extractAllFieldsFromTranscript("yes", "+15551234567", "caller_name").full_name, undefined);
});

test("invalid stored opening name is cleared without clearing callReason", () => {
  const sanitized = sanitizeInvalidStoredCallerName({
    full_name: "hail damage",
    problem_description: "hail damage from last night",
  });

  assert.equal(sanitized.full_name, undefined);
  assert.equal(sanitized.problem_description, "hail damage from last night");
});

test("caller name is selected before callback phone when missing", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
  };

  assert.equal(getNextRequiredField(fields), "full_name");
  assert.equal(isCallerNameResolved(fields), false);
});

test("damage language repeated during name question does not populate callerName", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { problem_description: "hail damage", pending_question: "caller_name" },
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Hail damage.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, undefined);
  assert.match(outcome.replyText, /name/i);
});

test("short yes answers still route through pending handlers only", () => {
  assert.equal(isShortPendingStyleAnswer("yes"), true);
  const merged = mergeRealtimeCallerAnswer(
    {
      problem_description: "hail damage",
      full_name: "Beau Spilker",
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
      pending_question: "insurance_claim",
    },
    "Yes",
    "+14025551234",
  );

  assert.equal(merged.full_name, "Beau Spilker");
  assert.equal(merged.insurance_claim_started, true);
});
