import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNameClarificationPrompt,
  extractExplicitCallerName,
  isPlausibleCallerName,
  validateCallerNameCandidate,
} from "../src/orchestrator/field-validation.js";
import {
  applyPendingQuestionAnswer,
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "../src/orchestrator/multi-field-extraction.js";
import {
  allowsCallbackAffirmativeReuse,
  needsCallbackConfirmation,
  resolvePendingQuestion,
} from "../src/orchestrator/pending-question.js";
import {
  buildSummaryDataObject,
  buildValidatedSpokenSummary,
} from "../src/orchestrator/summary-builder.js";
import {
  buildStructuredSpokenSummary,
  REALTIME_INTRO_TRANSITION,
  type RealtimeFields,
} from "../src/orchestrator/realtime-prompts.js";
import {
  confirmCallbackPhone,
  mergeRealtimeCallerAnswer,
} from "../src/orchestrator/realtime-intake.js";
import { confirmAddress } from "../src/orchestrator/address-confirmation.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";

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

test("My name is Beau and calling about hail damage separates name and reason", () => {
  const extracted = extractAllFieldsFromTranscript(
    "My name is Beau and I'm calling about hail damage",
    "+15551234567",
    "caller_name",
  );

  assert.equal(extracted.full_name, "Beau");
  assert.match(extracted.problem_description ?? "", /hail damage/i);
});

test("We had hail damage does not populate caller name", () => {
  const extracted = extractAllFieldsFromTranscript("We had hail damage", "+15551234567", "call_reason");
  assert.equal(extracted.full_name, undefined);
  assert.match(extracted.problem_description ?? "", /hail damage/i);
});

test("confirmed callback remains confirmed after insurance urgency and damage answers", () => {
  let fields: RealtimeFields = confirmCallbackPhone({
    callback_phone: "+14025551234",
    callback_phone_confirmed: false,
  });

  fields = mergeRealtimeCallerAnswer(fields, "No", "+14025551234", {
    pendingQuestion: "insurance_claim",
  });
  assert.equal(fields.callback_phone_confirmed, true);

  fields = mergeRealtimeCallerAnswer(fields, "Standard", "+14025551234", {
    pendingQuestion: "urgency",
  });
  assert.equal(fields.callback_phone_confirmed, true);
});

test("confirmed address remains confirmed throughout intake", () => {
  let fields: RealtimeFields = confirmAddress({
    address: "123 Main Street, Beatrice",
    address_confirmed: false,
  });

  fields = mergeRealtimeCallerAnswer(fields, "No", "+14025551234", {
    pendingQuestion: "insurance_claim",
  });

  assert.equal(fields.address_confirmed, true);
});

test("low-confidence name triggers clarification instead of saving damage language", () => {
  const validated = validateCallerNameCandidate("hail damage", { isDirectNameAnswer: true });
  assert.equal(validated.value, null);
  assert.equal(validated.needsClarification, true);
  assert.match(buildNameClarificationPrompt("hail damage"), /name/i);
});

test("spelled name updates callerName correctly", () => {
  const fields = applyPendingQuestionAnswer({}, "Beau Spilker", "+15551234567", "caller_name");
  assert.equal(fields.full_name, "Beau Spilker");
});

test("damage terms cannot pass caller-name validation", () => {
  assert.equal(isPlausibleCallerName("hail damage"), false);
  assert.equal(isPlausibleCallerName("roof leak"), false);
});

test("phone numbers cannot populate callerName", () => {
  assert.equal(isPlausibleCallerName("4025550198"), false);
  assert.equal(extractExplicitCallerName("402-555-0198"), null);
});

test("addresses cannot populate callerName", () => {
  assert.equal(isPlausibleCallerName("123 Main Street"), false);
});

test("summary is generated only from structured state", () => {
  const data = buildSummaryDataObject({
    full_name: "Beau Spilker",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    problem_description: "hail damage from last night",
    photos_available: true,
  });

  assert.equal(data.name, "Beau Spilker");
  assert.equal(data.damage, "hail damage from last night");
});

test("summary never places damage description in the name field", () => {
  const { summary, issues } = buildValidatedSpokenSummary({
    full_name: "hail damage",
    problem_description: "hail damage from last night",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
  });

  assert.equal(summary, "");
  assert.ok(issues.includes("invalid_name"));
});

test("summary contains no raw assistant acknowledgment text", () => {
  const summary = buildStructuredSpokenSummary({
    full_name: "Beau Spilker",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    problem_description: "hail damage",
    photos_available: true,
  });

  assert.doesNotMatch(summary, /Absolutely/i);
  assert.doesNotMatch(summary, /Thank you/i);
  assert.match(summary, /Beau Spilker/i);
});

test("caller correction updates only the corrected field", () => {
  const before: RealtimeFields = {
    full_name: "Beau Spilker",
    insurance_claim_started: false,
  };

  const merged = mergeExtractedFields(before, {
    insurance_claim_started: true,
  });

  assert.equal(merged.full_name, "Beau Spilker");
  assert.equal(merged.insurance_claim_started, true);
});

test("opening explanation occurs after caller explains reason for calling", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage last night",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
  });

  assert.match(outcome.replyText, /few questions/i);
  assert.match(outcome.replyText, /roofing team has everything they need/i);
});

test("opening says a few questions so roofing team has everything they need", () => {
  assert.match(REALTIME_INTRO_TRANSITION, /a few questions/i);
  assert.match(REALTIME_INTRO_TRANSITION, /roofing team has everything they need/i);
});

test("only one pending question is resolved at a time", () => {
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
  assert.equal(pending, null);
});

test("bare yes cannot reuse callback unless pending callback question", () => {
  assert.equal(allowsCallbackAffirmativeReuse("insurance_claim"), false);
  assert.equal(allowsCallbackAffirmativeReuse("callback_phone"), true);
});

test("insurance pending answer cannot reopen unrelated confirmed callback", () => {
  const fields = mergeExtractedFields(
    {
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
    },
    extractAllFieldsFromTranscript("Yes", "+14025551234", "insurance_claim"),
  );

  assert.equal(fields.callback_phone_confirmed, true);
  assert.equal(needsCallbackConfirmation(fields), false);
});
