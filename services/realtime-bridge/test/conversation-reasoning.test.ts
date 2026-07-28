import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationReasoning,
  buildReasoningAwareTransition,
  selectNextFieldWithReasoning,
} from "../src/orchestrator/conversation-reasoning.js";
import {
  getFieldCompletionStatus,
  isFieldAskable,
} from "../src/orchestrator/field-completion.js";
import {
  extractAddressFromSpeech,
  trimAddressAtConversationalBoundary,
} from "../src/orchestrator/multi-field-extraction.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
import {
  getMissingRequiredFields,
  getNaturalTransitionQuestion,
  getNextRequiredField,
} from "../src/orchestrator/required-intake.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const CALLER_PHONE = "+15551234567";

test("storm tomorrow implies urgency", () => {
  const speech =
    "It's leaking and another storm is coming tomorrow.";

  const fields = mergeRealtimeCallerAnswer(
    { full_name: "Jane Doe", problem_description: "roof leak" },
    speech,
    CALLER_PHONE,
  );

  assert.equal(fields.urgency, "high");
  assert.equal(getFieldCompletionStatus("urgency", fields), "derived");
  assert.equal(isFieldAskable("urgency", fields), false);
  assert.equal(getMissingRequiredFields(fields).includes("urgency"), false);
});

test("leaving town Friday implies timing", () => {
  const speech = "I'm leaving town Friday and need someone to look at the hail damage.";

  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "Jane Doe",
      problem_description: "hail damage",
      callback_phone: "+15551234567",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      emergency_or_active_leak: false,
      urgency: "standard",
      insurance_claim_started: false,
    },
    speech,
    CALLER_PHONE,
  );

  assert.match(fields.appointment_preference_raw ?? "", /before friday/i);
  assert.equal(getMissingRequiredFields(fields).includes("appointment_preference"), false);
});

test("after work around five satisfies callback preference", () => {
  const speech = "Call me after work around five.";

  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "Jane Doe",
      problem_description: "hail damage",
      callback_phone: "+15551234567",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      emergency_or_active_leak: false,
      urgency: "standard",
      insurance_claim_started: false,
    },
    speech,
    CALLER_PHONE,
  );

  assert.match(
    fields.appointment_preference_raw ?? fields.appointment_preference ?? "",
    /after work/i,
  );
  assert.equal(getMissingRequiredFields(fields).includes("appointment_preference"), false);
});

test("active leak prevents duplicate leak questions", () => {
  const fields = mergeRealtimeCallerAnswer(
    { full_name: "Jane Doe" },
    "Water is leaking into the kitchen ceiling from hail damage.",
    CALLER_PHONE,
  );

  assert.equal(fields.emergency_or_active_leak, true);
  assert.equal(getMissingRequiredFields(fields).includes("emergency_or_active_leak"), false);
  assert.equal(getNextRequiredField(fields), "callback_phone");
});

test("address parser stops before conversational words", () => {
  const address = extractAddressFromSpeech(
    "My address is 123 Main Street because the roof is leaking badly.",
  );

  assert.equal(address, "123 Main Street");
  assert.equal(
    trimAddressAtConversationalBoundary("456 Oak Avenue and I live alone"),
    "456 Oak Avenue",
  );
});

test("captured address is never requested again", () => {
  const fields: RealtimeFields = {
    full_name: "Jane Doe",
    problem_description: "hail damage",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
  };

  assert.equal(getMissingRequiredFields(fields).includes("address"), false);
  assert.notEqual(getNextRequiredField(fields), "address");
});

test("callback preference is never requested again when timing captured", () => {
  const fields: RealtimeFields = {
    full_name: "Jane Doe",
    problem_description: "hail damage",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    appointment_preference_raw: "after work around five",
    appointment_preference: "after work around five",
    schedule_confirmed: true,
  };

  assert.equal(getMissingRequiredFields(fields).includes("appointment_preference"), false);
});

test("inferred urgency prevents unnecessary scheduling questions", () => {
  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "Jane Doe",
      callback_phone: "+15551234567",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      insurance_claim_started: false,
    },
    "The roof is leaking and another storm is coming tomorrow.",
    CALLER_PHONE,
  );

  assert.equal(fields.urgency, "high");
  assert.equal(getMissingRequiredFields(fields).includes("urgency"), false);
  assert.equal(getMissingRequiredFields(fields).includes("appointment_preference"), false);
});

test("confirmed fields remain skipped", () => {
  const fields: RealtimeFields = {
    full_name: "Jane Doe",
    problem_description: "hail damage",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    appointment_preference: "tomorrow afternoon",
    schedule_confirmed: true,
    field_resolution: {
      callback_phone: "confirmed",
      address: "confirmed",
      appointment_preference: "confirmed",
    },
  };

  const reasoning = buildConversationReasoning(fields);

  assert.ok(reasoning.confirmedFacts.includes("callback_phone"));
  assert.ok(reasoning.confirmedFacts.includes("address"));
  assert.equal(reasoning.missingFacts.includes("callback_phone"), false);
  assert.equal(reasoning.missingFacts.includes("address"), false);
});

test("assistant always reasons before selecting next question", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    emergency_or_active_leak: false,
  };

  const reasoning = buildConversationReasoning(fields);
  const selected = selectNextFieldWithReasoning(fields);
  const viaRequiredIntake = getNextRequiredField(fields);

  assert.equal(selected, viaRequiredIntake);
  assert.equal(reasoning.nextField, selected);
  assert.ok(Array.isArray(reasoning.knownFacts));
  assert.ok(Array.isArray(reasoning.derivedFacts));
  assert.ok(Array.isArray(reasoning.missingFacts));
});

test("inferred urgency uses acknowledgment instead of generic urgency question", () => {
  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "Jane Doe",
      callback_phone: "+15551234567",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      insurance_claim_started: false,
    },
    "Water is leaking and another storm is coming tomorrow.",
    CALLER_PHONE,
  );

  const transition = getNaturalTransitionQuestion(
    "insurance_claim_started",
    fields,
    CALLER_PHONE,
  );

  assert.doesNotMatch(transition, /how urgent/i);
  assert.doesNotMatch(transition, /what day and time would be best/i);
});

test("buildReasoningAwareTransition acknowledges inferred urgency when asked", () => {
  const fields: RealtimeFields = {
    urgency: "high",
    field_resolution: { urgency: "derived" },
    problem_description: "leak with storm tomorrow",
  };

  const text = buildReasoningAwareTransition(
    "urgency",
    fields,
    "How urgent is this?",
  );

  assert.match(text, /mark this as urgent/i);
  assert.doesNotMatch(text, /how urgent/i);
});
