import assert from "node:assert/strict";
import test from "node:test";

import { confirmAddress } from "../src/orchestrator/address-confirmation.js";
import { confirmCallbackPhone } from "../src/orchestrator/realtime-intake.js";
import {
  applyAnswerForPendingQuestion,
  isShortPendingStyleAnswer,
} from "../src/orchestrator/multi-field-extraction.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
import {
  getNextRequiredField,
  getMissingRequiredFields,
} from "../src/orchestrator/required-intake.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  buildValidatedSpokenSummary,
} from "../src/orchestrator/summary-builder.js";
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

test("We had hail damage captures reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /Could I start with your name/i);
  assert.equal(
    getNextRequiredField(outcome.session?.collected_fields as RealtimeFields),
    "full_name",
  );
});

test("volunteered name on first turn is stored and not asked again", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My name is Beau and we had hail damage",
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

test("caller_name is selected before callback phone when both are missing", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
  };

  assert.equal(getNextRequiredField(fields), "full_name");
});

test("pending insurance yes sets insurance without reopening callback confirmation", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    pending_question: "insurance_claim",
  };

  const merged = mergeRealtimeCallerAnswer(fields, "Yes", "+14025551234", {
    conversationState: "collecting_intake",
  });

  assert.equal(merged.insurance_claim_started, true);
  assert.equal(merged.callback_phone_confirmed, true);
  assert.equal(merged.pending_question, undefined);
});

test("pending adjuster yes sets adjuster without reopening callback confirmation", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    insurance_claim_started: true,
    pending_question: "adjuster_contacted",
  };

  const merged = mergeRealtimeCallerAnswer(fields, "Yes", "+14025551234");

  assert.equal(merged.adjuster_contacted, true);
  assert.equal(merged.callback_phone_confirmed, true);
});

test("confirmed callback stays confirmed after unrelated short yes", () => {
  let fields: RealtimeFields = confirmCallbackPhone({
    callback_phone: "+14025551234",
    callback_phone_confirmed: false,
  });

  fields = mergeRealtimeCallerAnswer(fields, "No", "+14025551234", {
    pendingQuestion: "insurance_claim",
  });
  assert.equal(fields.callback_phone_confirmed, true);

  fields = mergeRealtimeCallerAnswer(fields, "Yes", "+14025551234", {
    pendingQuestion: "adjuster_contacted",
  });
  assert.equal(fields.callback_phone_confirmed, true);
});

test("confirmed address stays confirmed after unrelated short yes", () => {
  let fields: RealtimeFields = confirmAddress({
    address: "123 Main Street, Beatrice",
    address_confirmed: false,
  });
  fields = { ...fields, address_confirmed: true };

  fields = mergeRealtimeCallerAnswer(fields, "Yes", "+14025551234", {
    pendingQuestion: "insurance_claim",
  });

  assert.equal(fields.address_confirmed, true);
});

test("photos are never selected as pending question", () => {
  const pending = resolvePendingQuestion(
    {
      problem_description: "hail damage",
      full_name: "Beau",
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      emergency_or_active_leak: false,
      urgency: "standard",
      insurance_claim_started: false,
      appointment_preference: "July 21 at 2 PM",
      schedule_confirmed: true,
    },
    "collecting_intake",
  );

  assert.notEqual(pending, "photos_available");
});

test("photos do not appear in required fields", () => {
  const missing = getMissingRequiredFields({ problem_description: "hail damage" });
  assert.equal(
    missing.some((field) => (field as string) === "photos_available"),
    false,
  );
});

test("photos do not appear in spoken summary", () => {
  const { summary } = buildValidatedSpokenSummary({
    full_name: "Beau Spilker",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    problem_description: "hail damage",
    photos_available: true,
  });

  assert.doesNotMatch(summary, /photos/i);
});

test("short yes only updates pending insurance field via applyAnswerForPendingQuestion", () => {
  assert.equal(isShortPendingStyleAnswer("Yes"), true);

  const updated = applyAnswerForPendingQuestion(
    {
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
    },
    "Yes",
    "+14025551234",
    "insurance_claim",
  );

  assert.equal(updated.insurance_claim_started, true);
  assert.equal(updated.callback_phone_confirmed, true);
});

test("unresolved callback confirmation is not selected while caller name is missing", () => {
  const pending = resolvePendingQuestion(
    {
      problem_description: "hail damage",
      callback_phone: "+14025551234",
      callback_phone_confirmed: false,
    },
    "collecting_intake",
  );

  assert.equal(pending, "caller_name");
});
