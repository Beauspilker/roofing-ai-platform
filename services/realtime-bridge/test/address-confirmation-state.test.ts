import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmAddress,
  needsAddressReadback,
} from "../src/orchestrator/address-confirmation.js";
import { mergeExtractedFields } from "../src/orchestrator/multi-field-extraction.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
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

test("confirmed address is never requested again", () => {
  const fields = confirmAddress({
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: false,
    pending_question: "address_confirmation",
  });

  assert.equal(fields.address_confirmed, true);
  assert.equal(needsAddressReadback(fields), false);
  assert.notEqual(getNextRequiredField(fields), "address");
});

test("unrelated weather speech cannot reopen address confirmation", () => {
  const before = confirmAddress({
    address: "123 Main Street, Beatrice, Nebraska",
    full_name: "Jane Doe",
    problem_description: "roof leak",
    callback_phone: "+14025550187",
    callback_phone_confirmed: true,
  });

  const after = mergeExtractedFields(
    before,
    extractFieldsFromWeatherSpeech(),
    "Another storm is supposed to come through tomorrow.",
  );

  assert.equal(after.address_confirmed, true);
  assert.equal(needsAddressReadback(after), false);
});

test("confirmation acceptance clears pending address confirmation state", () => {
  const fields = confirmAddress({
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: false,
    pending_question: "address_confirmation",
    field_being_confirmed: "address",
    confirmation_candidate: "123 Main Street, Beatrice, Nebraska",
  });

  assert.equal(fields.pending_question, undefined);
  assert.equal(fields.field_being_confirmed, undefined);
  assert.equal(fields.confirmation_candidate, undefined);
});

test("explicit correction can reopen address confirmation once", async () => {
  const fields: RealtimeFields = {
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
    pending_question: "address_confirmation",
    field_being_confirmed: "address",
    confirmation_candidate: "123 Main Street, Beatrice, Nebraska",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "No, the address is 456 Lincoln Avenue in Beatrice.",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /456 Lincoln Avenue/i);
  assert.equal(outcome.nextConversationState, "awaiting_address_confirmation");
});

test("corrected address can be confirmed once and then skipped", async () => {
  const policy = new AcknowledgmentPolicy();
  const correctedFields: RealtimeFields = {
    full_name: "Jane Doe",
    problem_description: "roof leak",
    callback_phone: "+14025550187",
    callback_phone_confirmed: true,
    address: "456 Lincoln Avenue, Beatrice",
    address_confirmed: false,
    pending_question: "address_confirmation",
    field_being_confirmed: "address",
    confirmation_candidate: "456 Lincoln Avenue, Beatrice",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: correctedFields },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "Yes, that's correct.",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const confirmed = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(confirmed.address_confirmed, true);
  assert.equal(needsAddressReadback(confirmed), false);
  assert.notEqual(getNextRequiredField(confirmed), "address");
});

function extractFieldsFromWeatherSpeech(): Partial<RealtimeFields> {
  return {
    urgency: "high",
    address: "123 Main Street, Beatrice, Nebraska another storm is supposed to come through tomorrow",
  };
}
