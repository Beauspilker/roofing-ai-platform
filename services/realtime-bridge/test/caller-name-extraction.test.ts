import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { normalizeCallReasonFromSpeech } from "../src/orchestrator/call-reason-handling.js";
import {
  extractExplicitCallerName,
  isInvalidCallerNameWord,
  isPlausibleCallerName,
  sanitizeInvalidStoredCallerName,
  validateCallerNameCandidate,
} from "../src/orchestrator/field-validation.js";
import {
  getNextRequiredField,
  isCallerNameResolved,
} from "../src/orchestrator/required-intake.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
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

async function processOpeningReason(speech: string) {
  return processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: speech,
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });
}

test("I'm calling about roof damage keeps callerName unresolved and selects caller_name", async () => {
  const outcome = await processOpeningReason("I'm calling about roof damage.");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.full_name, undefined);
  assert.match(fields.problem_description ?? "", /roof damage/i);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.match(outcome.replyText, /first and last name/i);
});

test("I am calling for hail damage keeps callerName unresolved", async () => {
  const outcome = await processOpeningReason("I am calling for hail damage.");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.full_name, undefined);
  assert.match(fields.problem_description ?? "", /hail damage/i);
});

test("I'm having a roof leak keeps callerName unresolved", async () => {
  const outcome = await processOpeningReason("I'm having a roof leak.");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.full_name, undefined);
  assert.match(fields.problem_description ?? "", /roof leak/i);
});

test("I'm Beau, and I'm calling about hail damage stores Beau and hail damage", async () => {
  const outcome = await processOpeningReason("I'm Beau, and I'm calling about hail damage.");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.full_name, "Beau");
  assert.match(fields.problem_description ?? "", /hail damage/i);
});

test("My name is Beau stores callerName", () => {
  assert.equal(extractExplicitCallerName("My name is Beau."), "Beau");
  assert.equal(
    validateCallerNameCandidate("My name is Beau.").value,
    "Beau",
  );
});

test("This is Beau calling about roof damage stores Beau and roof damage", async () => {
  const outcome = await processOpeningReason("This is Beau calling about roof damage.");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.full_name, "Beau");
  assert.match(fields.problem_description ?? "", /roof damage/i);
});

test("calling cannot pass name validation", () => {
  assert.equal(isInvalidCallerNameWord("calling"), true);
  assert.equal(isPlausibleCallerName("calling"), false);
  assert.equal(extractExplicitCallerName("I'm calling about roof damage."), null);
});

test("previously stored callerName calling is cleared before next-action selection", () => {
  const sanitized = sanitizeInvalidStoredCallerName({
    full_name: "calling",
    problem_description: "roof damage",
  });

  assert.equal(sanitized.full_name, undefined);
  assert.equal(sanitized.problem_description, "roof damage");
  assert.equal(getNextRequiredField(sanitized as RealtimeFields), "full_name");
});

test("when pendingQuestion is caller_name Beau Spilker is accepted", () => {
  const validated = validateCallerNameCandidate("Beau Spilker.", {
    isDirectNameAnswer: true,
  });

  assert.equal(validated.value, "Beau Spilker");
});

test("when pendingQuestion is reason_for_call roof damage cannot become callerName", () => {
  const merged = mergeRealtimeCallerAnswer(
    { pending_question: "reason_for_call" },
    "roof damage",
    "+15551234567",
    { conversationState: "collecting_intake", isFirstCallerTurn: true },
  );

  assert.equal(merged.full_name, undefined);
  assert.match(merged.problem_description ?? "", /roof damage/i);
  assert.equal(normalizeCallReasonFromSpeech("I'm calling about roof damage."), "roof damage");
});

test("caller name remains required before callback phone", () => {
  const fields: RealtimeFields = {
    problem_description: "roof damage",
  };

  assert.equal(isCallerNameResolved(fields), false);
  assert.equal(getNextRequiredField(fields), "full_name");
});
