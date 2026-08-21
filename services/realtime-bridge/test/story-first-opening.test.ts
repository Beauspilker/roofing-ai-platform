import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  addressConfirmationExcludesPhone,
  buildAddressConfirmationReply,
  buildPhoneConfirmationReply,
  phoneConfirmationExcludesAddress,
} from "../src/orchestrator/confirmation-builders.js";
import {
  applyAddressScopedCorrection,
  attachFieldConfirmationContext,
} from "../src/orchestrator/field-scoped-correction.js";
import { buildClosingMessage } from "../src/orchestrator/realtime-prompts.js";
import {
  REALTIME_OPENING_GREETING,
  REALTIME_OPENING_STORY_QUESTION,
} from "../src/orchestrator/realtime-prompts.js";
import { getMissingRequiredFields, getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
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

const CALLER_PHONE = "+14025550187";

test("opening asks an open-ended story question instead of requesting first name", () => {
  assert.match(REALTIME_OPENING_STORY_QUESTION, /what can we help you with today/i);
  assert.doesNotMatch(REALTIME_OPENING_STORY_QUESTION, /first and last name/i);
  assert.doesNotMatch(REALTIME_OPENING_GREETING, /\?/);
});

test("greeting response.done enters awaiting_opening_story with reason pending", () => {
  const orchestrator = new SessionOrchestrator({
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    calledPhone: "+14027611540",
  });

  (orchestrator as unknown as { session: typeof mockSession }).session = {
    ...mockSession,
  };

  orchestrator.markOpeningDelivered();
  orchestrator.onOpeningStoryQuestionComplete();

  assert.equal(orchestrator.getConversationState(), "awaiting_opening_story");

  const fields = (orchestrator.getSession()?.collected_fields ?? {}) as RealtimeFields;
  assert.equal(fields.pending_question, "reason_for_call");
  assert.equal(resolvePendingQuestion(fields, "awaiting_opening_story"), "reason_for_call");
});

test("detailed opening response captures multiple fields before asking another question", async () => {
  const speech =
    "Hi, my name is Beau Spilker. We had hail damage Tuesday night, and water is leaking into the kitchen ceiling. I haven't contacted insurance yet. My address is 123 Main Street in Beatrice, Nebraska, and my callback number is 402-555-0187.";

  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: speech,
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, "Beau Spilker");
  assert.match(fields.problem_description ?? "", /hail/i);
  assert.equal(fields.emergency_or_active_leak, true);
  assert.match(fields.address ?? "", /123 Main Street/i);
  assert.ok(fields.callback_phone);

  assert.doesNotMatch(outcome.replyText ?? "", /first and last name/i);
  assert.doesNotMatch(outcome.replyText ?? "", /what can we help you with today/i);
});

test("full opening capture does not re-ask captured fields", async () => {
  const speech =
    "My name is Beau Spilker. Hail damage with an active leak. Another storm is coming tomorrow. Insurance hasn't been contacted. Call me after work around five. Address is 123 Main Street and callback is 402-555-0187.";

  const fields = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);
  const missing = getMissingRequiredFields(fields);

  assert.equal(missing.includes("full_name"), false);
  assert.equal(missing.includes("problem_description"), false);
  assert.equal(missing.includes("address"), false);
  assert.equal(missing.includes("urgency"), false);
  assert.equal(missing.includes("appointment_preference"), false);
});

test("caller who omits name is asked for name later, not first", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: "We had hail damage and water is leaking into the kitchen.",
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, undefined);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.match(outcome.replyText ?? "", /first and last name/i);
  assert.doesNotMatch(outcome.replyText ?? "", /what can we help you with today/i);
});

test("short opening I need a roof repair receives one broad follow-up", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: "I need a roof repair.",
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText ?? "", /tell me a little more about what happened/i);
  assert.equal(outcome.nextConversationState, "awaiting_opening_story");
  assert.equal(
    (outcome.session?.collected_fields as RealtimeFields).opening_story_followup_attempts,
    1,
  );
});

test("broad follow-up cannot loop repeatedly", async () => {
  const first = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: "I have storm damage.",
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(first.replyText ?? "", /tell me a little more/i);

  const second = await processRealtimeCallerTurn({
    session: first.session,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: "Shingles are missing on the north side.",
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: false,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(second.replyText ?? "", /tell me a little more about what happened/i);
  assert.notEqual(second.nextConversationState, "awaiting_opening_story");
});

test("phone confirmation remains separate after story-first opening", async () => {
  const fields: RealtimeFields = {
    full_name: "Beau Spilker",
    problem_description: "hail damage",
    callback_phone: "+14025550187",
    address: "123 Main Street, Beatrice, Nebraska",
  };

  const phoneReply = buildPhoneConfirmationReply(fields);
  assert.match(phoneReply, /callback number/i);
  assert.doesNotMatch(phoneReply, /service address/i);
  assert.equal(phoneConfirmationExcludesAddress(phoneReply, fields.address), true);
});

test("address confirmation remains separate after story-first opening", () => {
  const fields: RealtimeFields = {
    full_name: "Beau Spilker",
    problem_description: "hail damage",
    callback_phone: "+14025550187",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
  };

  const addressReply = buildAddressConfirmationReply(fields);
  assert.match(addressReply, /service address/i);
  assert.doesNotMatch(addressReply, /callback number/i);
});

test("field-scoped corrections still work after story-first opening", () => {
  const result = applyAddressScopedCorrection(
    attachFieldConfirmationContext(
      {
        full_name: "Beau Spilker",
        problem_description: "hail damage",
        address: "123 Main Street, Beatrice, Nebraska",
        address_confirmed: false,
      },
      "address",
      "123 Main Street, Beatrice, Nebraska",
    ),
    "Everything is correct except add Apartment B to the address.",
  );

  assert.equal(result.fields.address, "123 Main Street, Apartment B, Beatrice, Nebraska");
});

test("storm context still infers urgency during story-first opening", async () => {
  const fields = mergeRealtimeCallerAnswer(
    {},
    "Water is leaking and another storm is coming tomorrow.",
    CALLER_PHONE,
  );

  assert.equal(fields.urgency, "high");
  assert.equal(getMissingRequiredFields(fields).includes("urgency"), false);
});

test("callback timing is still inferred during story-first opening", async () => {
  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "Jane Doe",
      problem_description: "hail damage",
      callback_phone: "+15551234567",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      emergency_or_active_leak: false,
      insurance_claim_started: false,
    },
    "Call me after work around five.",
    CALLER_PHONE,
  );

  assert.match(
    fields.appointment_preference_raw ?? fields.appointment_preference ?? "",
    /after work/i,
  );
});

test("confirmed or completed fields are not asked again after story opening", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult:
      "I'm Beau Spilker at 123 Main Street. Hail damage, no active leak, insurance not started, call me at 402-555-0187.",
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  const missing = getMissingRequiredFields(fields);

  assert.equal(missing.includes("full_name"), false);
  assert.equal(missing.includes("address"), false);
  assert.equal(missing.includes("problem_description"), false);
  assert.doesNotMatch(outcome.replyText ?? "", /property address/i);
});

test("professional closing uses natural personalized wording", () => {
  const closing = buildClosingMessage({
    fields: {
      full_name: "Beau Spilker",
      caller_first_name: "Beau",
      callback_phone: "+14025550187",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      problem_description: "hail damage",
      emergency_or_active_leak: false,
      insurance_claim_started: false,
      appointment_preference: "tomorrow afternoon",
      schedule_confirmed: true,
      summary_confirmed: true,
    },
  });

  assert.match(closing, /Alright/i);
  assert.match(closing, /Beau/i);
  assert.match(closing, /Thanks for calling/i);
  assert.doesNotMatch(closing, /Does all of that sound correct/i);
});
