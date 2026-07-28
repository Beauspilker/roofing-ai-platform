import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  isAddressConfirmed,
  isAddressConfirmedSpeech,
  needsAddressReadback,
} from "../src/orchestrator/address-confirmation.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import {
  normalizeRealtimeFields,
  toPersistedFields,
} from "../src/orchestrator/realtime-intake.js";
import type { ConversationState } from "../src/orchestrator/conversation-state.js";
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

async function runTurn(
  session: typeof mockSession,
  speech: string,
  conversationState: ConversationState,
) {
  const policy = new AcknowledgmentPolicy();
  return processRealtimeCallerTurn({
    session,
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: speech,
    conversationState,
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });
}

test("live scenario: yes after address confirmation advances intake once", async () => {
  let session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
      callback_phone: "+14025550199",
      callback_phone_confirmed: true,
    } as RealtimeFields,
  };

  const addressTurn = await runTurn(
    session,
    "123 Main Street, Beatrice, Nebraska",
    "collecting_intake",
  );

  session = addressTurn.session ?? session;
  const fieldsAfterAddress = session.collected_fields as RealtimeFields;

  assert.match(addressTurn.replyText, /service address is/i);
  assert.equal(addressTurn.nextConversationState, "awaiting_address_confirmation");
  assert.equal(fieldsAfterAddress.address_confirmed, false);
  assert.equal(needsAddressReadback(fieldsAfterAddress), true);

  const confirmTurn = await runTurn(session, "Yes.", addressTurn.nextConversationState);

  session = confirmTurn.session ?? session;
  const fieldsAfterYes = session.collected_fields as RealtimeFields;

  assert.equal(fieldsAfterYes.address_confirmed, true);
  assert.equal(needsAddressReadback(fieldsAfterYes), false);
  assert.equal(isAddressConfirmed(fieldsAfterYes), true);
  assert.notEqual(getNextRequiredField(fieldsAfterYes), "address");
  assert.doesNotMatch(confirmTurn.replyText, /service address is .*Is that correct/i);
  assert.notEqual(confirmTurn.nextConversationState, "awaiting_address_confirmation");

  const repeatTurn = await runTurn(session, "Yes.", confirmTurn.nextConversationState);

  assert.doesNotMatch(repeatTurn.replyText, /service address is .*Is that correct/i);
  assert.notEqual(repeatTurn.nextConversationState, "awaiting_address_confirmation");
});

test("live scenario: full callback capture then address confirm does not loop", async () => {
  let session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage on the roof",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
    } as RealtimeFields,
  };

  const phoneTurn = await runTurn(session, "402-555-0199", "collecting_intake");
  session = phoneTurn.session ?? session;

  const callbackConfirmTurn = await runTurn(
    session,
    "Yes",
    "awaiting_callback_confirmation",
  );
  session = callbackConfirmTurn.session ?? session;

  const addressTurn = await runTurn(
    session,
    "My address is 123 Main Street in Beatrice, Nebraska",
    "collecting_intake",
  );
  session = addressTurn.session ?? session;

  assert.match(addressTurn.replyText, /service address is/i);
  assert.equal(addressTurn.nextConversationState, "awaiting_address_confirmation");

  const yesTurn = await runTurn(session, "Yes", addressTurn.nextConversationState);
  session = yesTurn.session ?? session;
  const fields = session.collected_fields as RealtimeFields;

  assert.equal(fields.address_confirmed, true);
  assert.doesNotMatch(yesTurn.replyText, /service address is .*Is that correct/i);

  const secondYes = await runTurn(session, "Yes", yesTurn.nextConversationState);
  assert.doesNotMatch(secondYes.replyText, /service address is .*Is that correct/i);
});

test("address confirmation accepts yes that's correct without looping", async () => {
  let session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
      callback_phone: "+14025550199",
      callback_phone_confirmed: true,
      address: "123 Main Street in Beatrice, Nebraska",
      address_confirmed: false,
      pending_question: "address_confirmation",
      field_being_confirmed: "address",
    } as RealtimeFields,
  };

  const outcome = await runTurn(session, "Yes, that's correct", "awaiting_address_confirmation");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.address_confirmed, true);
  assert.doesNotMatch(outcome.replyText, /service address is .*Is that correct/i);
});

test("live scenario: yes with collecting_intake and pending address_confirmation still confirms once", async () => {
  let session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
      callback_phone: "+14025550199",
      callback_phone_confirmed: true,
      address: "123 Main Street, Beatrice, Nebraska",
      address_confirmed: false,
      pending_question: "address_confirmation",
      field_being_confirmed: "address",
      activeConfirmationField: "address",
      current_field_value: "123 Main Street, Beatrice, Nebraska",
      activeConfirmationValue: "123 Main Street, Beatrice, Nebraska",
      confirmationStatus: "pending",
    } as RealtimeFields,
  };

  const confirmTurn = await runTurn(session, "Yes", "collecting_intake");

  const fields = confirmTurn.session?.collected_fields as RealtimeFields;

  assert.equal(fields.address_confirmed, true);
  assert.equal(needsAddressReadback(fields), false);
  assert.doesNotMatch(confirmTurn.replyText, /service address is .*Is that correct/i);
});

test("address confirmation accepts filler-prefixed yes from live STT", async () => {
  assert.equal(isAddressConfirmedSpeech("Uh, yes"), true);
  assert.equal(isAddressConfirmedSpeech("Okay, yes"), true);

  const session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
      callback_phone: "+14025550199",
      callback_phone_confirmed: true,
      address: "123 Main Street, Beatrice, Nebraska",
      address_confirmed: false,
      pending_question: "address_confirmation",
      field_being_confirmed: "address",
    } as RealtimeFields,
  };

  const outcome = await runTurn(session, "Uh, yes", "awaiting_address_confirmation");
  const fields = outcome.session?.collected_fields as RealtimeFields;

  assert.equal(fields.address_confirmed, true);
  assert.equal(fields.confirmationStatus, undefined);
  assert.equal(fields.field_being_confirmed, undefined);
  assert.equal(needsAddressReadback(fields), false);
  assert.doesNotMatch(outcome.replyText, /service address is .*Is that correct/i);
  assert.notEqual(outcome.nextConversationState, "awaiting_address_confirmation");
});

test("confirmed address survives persistence round-trip before next turn", async () => {
  let session = {
    ...mockSession,
    collected_fields: {
      problem_description: "hail damage",
      full_name: "Jane Smith",
      caller_first_name: "Jane",
      caller_last_name: "Smith",
      opening_name_complete: true,
      callback_phone: "+14025550199",
      callback_phone_confirmed: true,
      address: "123 Main Street in Beatrice, Nebraska",
      address_confirmed: false,
      pending_question: "address_confirmation",
      field_being_confirmed: "address",
    } as RealtimeFields,
  };

  const confirmTurn = await runTurn(session, "Yes.", "awaiting_address_confirmation");
  session = confirmTurn.session ?? session;

  const persisted = toPersistedFields(session.collected_fields as RealtimeFields);
  const reloadedSession = {
    ...session,
    collected_fields: normalizeRealtimeFields(persisted as RealtimeFields),
  };
  const reloadedFields = reloadedSession.collected_fields as RealtimeFields;

  assert.equal(reloadedFields.address_confirmed, true);
  assert.equal(needsAddressReadback(reloadedFields), false);
  assert.equal(reloadedFields.field_resolution?.address, "confirmed");

  const nextTurn = await runTurn(reloadedSession, "No", confirmTurn.nextConversationState);
  assert.doesNotMatch(nextTurn.replyText, /service address is .*Is that correct/i);
});
