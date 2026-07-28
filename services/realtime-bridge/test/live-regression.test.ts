import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  addressConfirmationExcludesPhone,
  buildAddressConfirmationReply,
  buildPhoneConfirmationReply,
} from "../src/orchestrator/confirmation-builders.js";
import {
  applyAddressScopedCorrection,
  applyCallbackScopedCorrection,
  attachFieldConfirmationContext,
  stripConversationalCorrectionFraming,
} from "../src/orchestrator/field-scoped-correction.js";
import { formatCallbackForSpeech } from "../src/orchestrator/callback-phone.js";
import { buildClosingMessage } from "../src/orchestrator/realtime-prompts.js";
import { getMissingRequiredFields } from "../src/orchestrator/required-intake.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
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

test("TEST A — long opening, no duplicate leak question", async () => {
  const speech =
    "Hi, my name is Beau Spilker. We had hail damage Tuesday night, and water is leaking into the kitchen ceiling. I haven't contacted insurance yet. My address is 123 Main Street in Beatrice, Nebraska, and my callback number is 402-555-0187.";

  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: speech,
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, "Beau Spilker");
  assert.match(fields.problem_description ?? "", /hail/i);
  assert.equal(fields.emergency_or_active_leak, true);
  assert.equal(fields.insurance_claim_started, false);
  assert.match(fields.address ?? "", /123 Main Street/i);
  assert.ok(fields.callback_phone);

  const missing = getMissingRequiredFields(fields);
  assert.equal(missing.includes("emergency_or_active_leak"), false);
  assert.doesNotMatch(outcome.replyText ?? "", /active leak or water getting inside/i);
});

test("TEST B — scoped address correction with city preserved", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      { address: "123 Main Street, Beatrice, Nebraska", address_confirmed: false },
      "address",
      "123 Main Street, Beatrice, Nebraska",
    ),
    "Everything is correct except add Apartment B to the address.",
  );

  assert.equal(result.fields.address, "123 Main Street, Apartment B, Beatrice, Nebraska");
  assert.match(result.replyText ?? "", /Apartment B/i);
  assert.doesNotMatch(result.replyText ?? "", /Everything is correct except/i);
  assert.doesNotMatch(result.replyText ?? "", /402-555-0187/i);
});

test("TEST C — scoped phone correction preserves unrelated fields", () => {
  const before: RealtimeFields = {
    full_name: "Beau Spilker",
    problem_description: "hail damage",
    address: "123 Main Street",
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
  };

  const result = applyCallbackScopedCorrection(
    attachFieldConfirmationContext(before, "callback_phone", before.callback_phone ?? ""),
    "Everything is right except the last digit should be eight.",
    "+14025550187",
  );

  assert.equal(formatCallbackForSpeech(result.fields.callback_phone ?? ""), "402-555-0188");
  assert.equal(result.fields.full_name, before.full_name);
  assert.equal(result.fields.problem_description, before.problem_description);
  assert.equal(result.fields.address, before.address);
});

test("TEST D — normal closing skips full readback", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    caller_first_name: "Beau",
    caller_last_name: "Spilker",
    callback_phone: "+14025550187",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
    emergency_or_active_leak: true,
    urgency: "standard",
    insurance_claim_started: false,
    appointment_preference: "tomorrow afternoon",
    schedule_confirmed: true,
    additional_notes_responded: false,
    photos_available: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "No, that's all",
    conversationState: "awaiting_additional_notes",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.doesNotMatch(outcome.replyText ?? "", /Does all of that sound correct/i);
  assert.match(outcome.replyText ?? "", /Perfect, I have everything I need/i);
  assert.match(outcome.replyText ?? "", /I'll send this information/i);
  assert.match(outcome.replyText ?? "", /have a great day/i);
  assert.equal(outcome.hangupAfterMark, true);
  assert.equal(outcome.nextConversationState, "delivering_closing");
});

test("TEST E — save-state wording uses future tense before dispatch", () => {
  assert.match(buildClosingMessage({ informationSent: false }), /I'll send this information/i);
  assert.doesNotMatch(buildClosingMessage({ informationSent: false }), /I've sent your information/i);
  assert.match(buildClosingMessage({ informationSent: true }), /I've sent your information/i);
});

test("confirmation builders keep phone and address separate on every path", () => {
  const fields: RealtimeFields = {
    callback_phone: "+14025550187",
    address: "123 Main Street, Beatrice, Nebraska",
  };

  const phoneReply = buildPhoneConfirmationReply(fields);
  const addressReply = buildAddressConfirmationReply(fields);

  assert.match(phoneReply, /Just to confirm, your callback number is 402-555-0187/i);
  assert.match(addressReply, /And your service address is 123 Main Street/i);
  assert.equal(addressConfirmationExcludesPhone(addressReply, fields.callback_phone), true);
  assert.doesNotMatch(addressReply, /402-555-0187/i);
});

test("conversational framing strips to the address suffix", () => {
  assert.equal(
    stripConversationalCorrectionFraming(
      "Everything is correct except add Apartment B to the address.",
    ),
    "add Apartment B",
  );
});

test("merge pipeline infers leak from stored problem description", () => {
  const merged = mergeRealtimeCallerAnswer(
    { problem_description: "water is leaking into the kitchen ceiling" },
    "Yes",
    "+14025550187",
    { pendingQuestion: "insurance_claim" },
  );

  assert.equal(merged.emergency_or_active_leak, true);
  assert.equal(getMissingRequiredFields(merged).includes("emergency_or_active_leak"), false);
});
