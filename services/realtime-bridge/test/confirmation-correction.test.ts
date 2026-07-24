import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy, shouldUseSafetyAcknowledgment } from "../src/orchestrator/acknowledgment-policy.js";
import {
  buildAddressReadbackConfirmation,
  sanitizeAddressValue,
} from "../src/orchestrator/address-confirmation.js";
import {
  buildCallbackReadbackConfirmation,
  formatCallbackForSpeech,
} from "../src/orchestrator/callback-phone.js";
import { buildContextualMultiFieldAcknowledgment } from "../src/orchestrator/contextual-acknowledgment.js";
import {
  addressConfirmationExcludesPhone,
  applyAddressScopedCorrection,
  applyCallbackScopedCorrection,
  attachFieldConfirmationContext,
  callbackConfirmationExcludesAddress,
  processFieldConfirmationResponse,
  stripConversationalCorrectionFraming,
} from "../src/orchestrator/field-scoped-correction.js";
import { buildIntakeReply } from "../src/orchestrator/realtime-intake.js";
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

test("phone and address confirmations are always separate", () => {
  const phoneReply = buildCallbackReadbackConfirmation("+14025550187");
  const addressReply = buildAddressReadbackConfirmation("123 Main Street");

  assert.match(phoneReply, /Just to confirm, your callback number is 402-555-0187/i);
  assert.match(addressReply, /And your service address is 123 Main Street/i);
  assert.notEqual(phoneReply.trim(), addressReply.trim());
});

test("phone confirmation contains no address", () => {
  const reply = buildCallbackReadbackConfirmation("+14025550187");
  assert.equal(callbackConfirmationExcludesAddress(reply, "123 Main Street"), true);
  assert.doesNotMatch(reply, /Main Street/i);
});

test("address confirmation contains no phone number", () => {
  const reply = buildAddressReadbackConfirmation("123 Main Street");
  assert.equal(addressConfirmationExcludesPhone(reply, "+14025550187"), true);
  assert.doesNotMatch(reply, /402-555-0187/i);
});

test("active address confirmation scopes an ambiguous correction to address", () => {
  const fields: RealtimeFields = attachFieldConfirmationContext(
    { address: "123 Main Street", address_confirmed: false },
    "address",
    "123 Main Street",
  );

  const result = applyAddressScopedCorrection(fields, "Add an I at the end.");

  assert.equal(result.outcome, "needs_clarification");
  assert.match(result.replyText ?? "", /letter I to the end of the address/i);
  assert.equal(result.fields.field_being_confirmed, "address");
});

test("active phone confirmation scopes an ambiguous correction to phone", () => {
  const fields: RealtimeFields = attachFieldConfirmationContext(
    { callback_phone: "+14025550187", callback_phone_confirmed: false },
    "callback_phone",
    "+14025550187",
  );

  const result = applyCallbackScopedCorrection(
    fields,
    "The last digit should be eight.",
    "+14025550187",
  );

  assert.equal(result.outcome, "corrected");
  assert.equal(formatCallbackForSpeech(result.fields.callback_phone ?? ""), "402-555-0188");
});

test("everything is correct except add Apartment B updates only address", () => {
  const before: RealtimeFields = {
    callback_phone: "+14025550187",
    callback_phone_confirmed: false,
    address: "123 Main Street",
    address_confirmed: false,
    full_name: "Beau Spilker",
    problem_description: "hail damage",
  };

  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(before, "address", before.address ?? ""),
    "Everything is correct except add Apartment B.",
  );

  assert.match(result.fields.address ?? "", /Apartment B/i);
  assert.equal(result.fields.callback_phone, before.callback_phone);
  assert.equal(result.fields.full_name, before.full_name);
  assert.equal(result.fields.problem_description, before.problem_description);
});

test("everything is correct except add an I at the end does not store the full sentence", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      { address: "123 Main Street", address_confirmed: false },
      "address",
      "123 Main Street",
    ),
    "Everything is correct except add an I at the end.",
  );

  assert.notEqual(result.fields.address, "Everything is correct except add an I at the end.");
  assert.equal(result.outcome, "needs_clarification");
});

test("correcting one phone digit preserves the rest of the phone number", () => {
  const result = applyCallbackScopedCorrection(
    attachFieldConfirmationContext(
      { callback_phone: "+14025550187", callback_phone_confirmed: false },
      "callback_phone",
      "+14025550187",
    ),
    "The last digit should be eight.",
    "+14025550187",
  );

  assert.equal(formatCallbackForSpeech(result.fields.callback_phone ?? ""), "402-555-0188");
});

test("correcting street direction preserves the rest of the address", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      { address: "123 South Main Street", address_confirmed: false },
      "address",
      "123 South Main Street",
    ),
    "It's North Main, not South Main.",
  );

  assert.match(result.fields.address ?? "", /North Main/i);
  assert.doesNotMatch(result.fields.address ?? "", /South Main/i);
  assert.match(result.fields.address ?? "", /123/i);
});

test("replacing a ZIP code preserves the street address", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      { address: "123 Main Street, 68501", address_confirmed: false },
      "address",
      "123 Main Street, 68501",
    ),
    "The ZIP is 68510.",
  );

  assert.match(result.fields.address ?? "", /123 Main Street/i);
  assert.match(result.fields.address ?? "", /68510/);
});

test("conversational correction words are stripped from stored values", () => {
  const cleaned = stripConversationalCorrectionFraming(
    "Everything is correct except add Apartment B.",
  );

  assert.equal(cleaned, "add Apartment B");
});

test("corrected field is the only field reread", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      { address: "123 Main Street", address_confirmed: false },
      "address",
      "123 Main Street",
    ),
    "Add Apartment B.",
  );

  assert.match(result.replyText ?? "", /Got it\. I now have your service address as/i);
  assert.doesNotMatch(result.replyText ?? "", /callback number/i);
  assert.doesNotMatch(result.replyText ?? "", /hail/i);
});

test("all unrelated fields remain unchanged after correction", () => {
  const before: RealtimeFields = {
    callback_phone: "+14025550187",
    full_name: "Beau Spilker",
    problem_description: "hail damage",
    insurance_claim_started: false,
    address: "123 Main Street",
    address_confirmed: false,
  };

  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(before, "address", before.address ?? ""),
    "Add Apartment B.",
  );

  assert.equal(result.fields.callback_phone, before.callback_phone);
  assert.equal(result.fields.full_name, before.full_name);
  assert.equal(result.fields.problem_description, before.problem_description);
  assert.equal(result.fields.insurance_claim_started, before.insurance_claim_started);
});

test("one ambiguous correction triggers one clarification only", () => {
  let fields: RealtimeFields = attachFieldConfirmationContext(
    { address: "123 Main Street", address_confirmed: false },
    "address",
    "123 Main Street",
  );

  const first = applyAddressScopedCorrection(fields, "Add an I at the end.");
  assert.equal(first.outcome, "needs_clarification");

  const second = applyAddressScopedCorrection(first.fields, "Add an I at the end.");
  assert.notEqual(second.outcome, "needs_clarification");
});

test("failed clarification cannot create a loop", () => {
  const fields: RealtimeFields = {
    ...attachFieldConfirmationContext(
      { address: "123 Main Street", address_confirmed: false },
      "address",
      "123 Main Street",
    ),
    field_clarification_attempts: { address: 1 },
  };

  const result = applyAddressScopedCorrection(fields, "Add an I at the end.");
  assert.notEqual(result.outcome, "needs_clarification");
  assert.match(result.fields.additional_notes ?? "", /Unresolved address correction/i);
});

test("long multi-field answer gets one short contextual acknowledgement", () => {
  const before: RealtimeFields = {};
  const after: RealtimeFields = {
    problem_description: "hail damage with kitchen leak",
    insurance_claim_started: false,
  };

  const ack = buildContextualMultiFieldAcknowledgment(
    before,
    after,
    "We had hail Tuesday, water is leaking into the kitchen, and I haven't called insurance yet.",
  );

  assert.match(ack ?? "", /Thanks\. I've noted/i);
  assert.match(ack ?? "", /hail damage/i);
  assert.match(ack ?? "", /insurance hasn't been contacted/i);
});

test("normal yes/no answers do not receive unnecessary summaries", () => {
  const policy = new AcknowledgmentPolicy();
  const reply = buildIntakeReply(
    policy,
    { problem_description: "leak", full_name: "Beau Spilker" },
    "Yes",
    "+14025550187",
    0,
    false,
    { problem_description: "leak" },
  );

  assert.doesNotMatch(reply, /I've noted/i);
});

test("random safety acknowledgement is not generated", () => {
  assert.equal(
    shouldUseSafetyAcknowledgment("We had hail damage and a kitchen leak."),
    false,
  );
});

test("already captured fields are not asked again after a correction", async () => {
  const correctedAddress = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: {
        full_name: "Beau Spilker",
        problem_description: "hail damage",
        callback_phone: "+14025550187",
        callback_phone_confirmed: true,
        address: "123 Main Street",
        address_confirmed: false,
        pending_question: "address_confirmation",
        field_being_confirmed: "address",
        current_field_value: "123 Main Street",
      },
    },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "Add Apartment B.",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(correctedAddress.replyText ?? "", /Apartment B/i);
  assert.doesNotMatch(correctedAddress.replyText ?? "", /402-555-0187/i);
  assert.doesNotMatch(correctedAddress.replyText ?? "", /first and last name/i);
  assert.doesNotMatch(correctedAddress.replyText ?? "", /What can the roofing team help/i);
});

test("sanitizeAddressValue removes embedded phone numbers", () => {
  assert.equal(
    sanitizeAddressValue("123 Main Street, call me at 402-555-0199"),
    "123 Main Street,",
  );
});

test("confirmed address response advances without repeating callback phone", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: {
        full_name: "Beau Spilker",
        problem_description: "hail damage",
        callback_phone: "+14025550187",
        callback_phone_confirmed: true,
        address: "123 Main Street, Apartment B",
        address_confirmed: false,
        pending_question: "address_confirmation",
      },
    },
    callSid: "CA123",
    callerPhone: "+14025550187",
    speechResult: "Yes",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.doesNotMatch(outcome.replyText ?? "", /402-555-0187/i);
});

test("processFieldConfirmationResponse marks accepted outcome", () => {
  const result = processFieldConfirmationResponse({
    fields: attachFieldConfirmationContext(
      { callback_phone: "+14025550187" },
      "callback_phone",
      "+14025550187",
    ),
    speech: "Yes",
    activeField: "callback_phone",
    isConfirmed: true,
    isRejected: false,
  });

  assert.equal(result.outcome, "accepted");
  assert.equal(result.fields.field_being_confirmed, undefined);
});
