import assert from "node:assert/strict";
import test from "node:test";

import { OpeningSilenceController } from "../src/bridge/opening-listening.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import {
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
  parseInsuranceLongAnswer,
} from "../src/orchestrator/multi-field-extraction.js";
import {
  appendAnythingElseNotes,
  mergeRealtimeCallerAnswer,
} from "../src/orchestrator/realtime-intake.js";
import {
  getMissingRequiredFields,
  getNextRequiredField,
  getRequiredFieldQuestion,
  getNaturalTransitionQuestion,
} from "../src/orchestrator/required-intake.js";
import {
  getFieldCompletionStatus,
  isFieldAskable,
  MAX_FIELD_CLARIFICATION_ATTEMPTS,
} from "../src/orchestrator/field-completion.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";
import { REALTIME_ANYTHING_ELSE_QUESTION } from "../src/orchestrator/realtime-prompts.js";

const CALLER_PHONE = "+15551234567";

test("one caller response fills multiple adaptive fields", () => {
  const speech =
    "My name is John Smith. We got hail Tuesday night and now water is coming into the kitchen. Insurance hasn't come out yet. I'm available after five and the address is 123 Main Street.";

  const merged = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);

  assert.equal(merged.full_name, "John Smith");
  assert.match(merged.address ?? "", /123 Main Street/i);
  assert.match(merged.problem_description ?? "", /water is coming into the kitchen/i);
  assert.equal(merged.adjuster_contacted, false);
  assert.equal(merged.emergency_or_active_leak, true);
  assert.match(merged.appointment_preference_raw ?? "", /after five/i);
  assert.equal(merged.storm_damage, "yes");
});

test("early multi-field capture avoids re-asking captured fields", () => {
  const speech =
    "My name is John Smith. We got hail Tuesday night and now water is coming into the kitchen. Insurance hasn't come out yet. I'm available after five and the address is 123 Main Street.";

  const fields = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);
  const missing = getMissingRequiredFields(fields);

  assert.equal(missing.includes("full_name"), false);
  assert.equal(missing.includes("problem_description"), false);
  assert.equal(missing.includes("address"), false);
  assert.equal(missing.includes("adjuster_contacted"), false);
  assert.equal(missing.includes("emergency_or_active_leak"), false);
});

test("long insurance no answer stores false and uncertain without forcing yes", () => {
  const speech =
    "I haven't contacted insurance because I wasn't sure if the damage was bad enough.";

  const merged = mergeRealtimeCallerAnswer(
    { problem_description: "hail damage", insurance_claim_started: undefined },
    speech,
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim" },
  );

  assert.equal(merged.insurance_claim_started, false);
  assert.equal(getFieldCompletionStatus("insurance_claim_started", merged), "uncertain");
  assert.equal(isFieldAskable("insurance_claim_started", merged), false);
  assert.match(merged.additional_notes ?? "", /wasn't sure/i);
});

test("long answer containing damage urgency and availability", () => {
  const speech =
    "Water is pouring into the bedroom, it's urgent, and I can talk anytime after work tomorrow.";

  const merged = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);

  assert.equal(merged.emergency_or_active_leak, true);
  assert.equal(merged.urgency, "emergency");
  assert.ok(merged.appointment_preference_raw || merged.appointment_preference);
});

test("caller correction replaces prior address", () => {
  const fields: RealtimeFields = {
    address: "123 Main Street",
    address_confirmed: true,
  };

  const merged = mergeRealtimeCallerAnswer(
    fields,
    "No, the address is 125 Main Street, not 123.",
    CALLER_PHONE,
  );

  assert.match(merged.address ?? "", /125 Main Street/i);
  assert.doesNotMatch(merged.address ?? "", /123 Main Street/);
  assert.equal(merged.address_confirmed, false);
});

test("uncertain insurance answer is not asked again", () => {
  const fields = mergeRealtimeCallerAnswer(
    { problem_description: "leak" },
    "I haven't contacted insurance because I wasn't sure if the damage was bad enough.",
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim" },
  );

  const next = getNextRequiredField(fields);
  assert.notEqual(next, "insurance_claim_started");
});

test("only missing fields are selected for next question", () => {
  const fields: RealtimeFields = {
    full_name: "John Smith",
    caller_first_name: "John",
    caller_last_name: "Smith",
    opening_name_complete: true,
    problem_description: "hail damage",
    address: "123 Main Street",
    address_confirmed: true,
    callback_phone: CALLER_PHONE,
    callback_phone_confirmed: true,
    emergency_or_active_leak: false,
    insurance_claim_started: false,
  };

  const next = getNextRequiredField(fields);
  assert.ok(next === "urgency" || next === "appointment_preference");
  assert.equal(getMissingRequiredFields(fields).includes("full_name"), false);
});

test("two unclear boolean answers cannot create an infinite loop", () => {
  let fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "Jane Doe",
    caller_first_name: "Jane",
    caller_last_name: "Doe",
    opening_name_complete: true,
    callback_phone: CALLER_PHONE,
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
  };

  for (let attempt = 0; attempt < MAX_FIELD_CLARIFICATION_ATTEMPTS; attempt += 1) {
    fields = mergeRealtimeCallerAnswer(fields, "maybe kind of", CALLER_PHONE, {
      pendingQuestion: "insurance_claim",
    });
  }

  assert.equal(isFieldAskable("insurance_claim_started", fields), false);
  assert.equal(getFieldCompletionStatus("insurance_claim_started", fields), "uncertain");
});

test("final open-ended answer updates notes and opportunistic fields", () => {
  const base: RealtimeFields = {
    problem_description: "leak",
    additional_notes_responded: true,
  };

  const updated = appendAnythingElseNotes(
    base,
    "Also, the back porch has a soft spot and I have photos on my phone.",
    CALLER_PHONE,
  );

  assert.match(updated.additional_notes ?? "", /back porch/i);
  assert.equal(updated.photos_available, true);
});

test("parseInsuranceLongAnswer handles adjuster not visited", () => {
  const parsed = parseInsuranceLongAnswer("Insurance hasn't come out yet.");
  assert.equal(parsed?.adjuster_contacted, false);
});

test("captured fields are not selected for duplicate questions", () => {
  const fields = mergeRealtimeCallerAnswer(
    {},
    "I'm John Smith at 123 Main Street with hail damage.",
    CALLER_PHONE,
  );

  const questionForName = getRequiredFieldQuestion("full_name", fields, CALLER_PHONE);
  const next = getNextRequiredField(fields);

  assert.notEqual(next, "full_name");
  assert.notEqual(next, "problem_description");
  assert.notEqual(next, "address");
  assert.ok(questionForName.length > 0);
  assert.match(REALTIME_ANYTHING_ELSE_QUESTION, /before I send this over/i);
});

test("multi-field extraction from transcript helper", () => {
  const extracted = extractAllFieldsFromTranscript(
    "I'm John Smith, the address is 123 Main Street, and a tree hit the roof yesterday.",
    CALLER_PHONE,
  );
  const merged = mergeExtractedFields({}, extracted);

  assert.equal(merged.full_name, "John Smith");
  assert.match(merged.address ?? "", /123 Main Street/i);
});

test("duplicate assistant prompt blocked before caller responds", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isActiveResponse(), true);
});

test("duplicate transcript registration is blocked", () => {
  const guard = new ResponseStateGuard();
  assert.equal(guard.registerCallerTranscript("item-1"), true);
  assert.equal(guard.registerCallerTranscript("item-1"), false);
});

test("natural transition question targets next missing field only", () => {
  const fields: RealtimeFields = {
    problem_description: "hail",
    full_name: "John Smith",
    caller_first_name: "John",
    caller_last_name: "Smith",
    opening_name_complete: true,
  };

  const next = getNextRequiredField(fields);
  assert.equal(next, "callback_phone");
  assert.match(
    getNaturalTransitionQuestion(next!, fields, CALLER_PHONE),
    /best number|callback/i,
  );
});

test("opening response captures name plus future answers from one transcript", async () => {
  const speech =
    "My name is Beau Spilker. We got hail Tuesday night, insurance hasn't been contacted, and I'm available tomorrow afternoon.";

  const outcome = await processRealtimeCallerTurn({
    session: {
      id: "session-1",
      twilio_call_sid: "CA123",
      company_id: "company-1",
      caller_phone: CALLER_PHONE,
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
    },
    callSid: "CA123",
    callerPhone: CALLER_PHONE,
    speechResult: speech,
    conversationState: "awaiting_opening_story",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.full_name, "Beau Spilker");
  assert.match(fields.problem_description ?? "", /hail/i);
  assert.equal(fields.insurance_claim_started, false);
  assert.match(fields.appointment_preference_raw ?? "", /tomorrow afternoon/i);
  assert.notEqual(outcome.nextConversationState, "listening_for_reason");
  assert.doesNotMatch(outcome.replyText, /What can the roofing team help you with today/i);
});

test("name correction during opening does not store problem_description", () => {
  const extracted = extractAllFieldsFromTranscript(
    "No, Beau Spilker",
    CALLER_PHONE,
    "caller_name",
  );

  assert.equal(extracted.problem_description, undefined);
});

test("long insurance haven't called answer stores false and uncertain", () => {
  const merged = mergeRealtimeCallerAnswer(
    { problem_description: "leak" },
    "I haven't called insurance because I wasn't sure if it was bad enough.",
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim", conversationState: "collecting_intake" },
  );

  assert.equal(merged.insurance_claim_started, false);
  assert.equal(getFieldCompletionStatus("insurance_claim_started", merged), "uncertain");
  assert.equal(isFieldAskable("insurance_claim_started", merged), false);
});

test("adjuster visited but unresolved is captured without forcing yes no", () => {
  const parsed = parseInsuranceLongAnswer(
    "They came out yesterday, but nothing has been approved.",
  );
  assert.equal(parsed?.adjuster_contacted, true);
  assert.equal(parsed?.insuranceStatus, "adjuster_visited_unresolved");

  const merged = mergeRealtimeCallerAnswer(
    { problem_description: "leak", insurance_claim_started: undefined },
    "They came out yesterday, but nothing has been approved.",
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim" },
  );

  assert.equal(merged.adjuster_contacted, true);
  assert.equal(isFieldAskable("insurance_claim_started", merged), false);
});

test("paying out of pocket resolves insurance without looping", () => {
  const merged = mergeRealtimeCallerAnswer(
    { problem_description: "leak" },
    "I'm paying out of pocket.",
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim" },
  );

  assert.equal(merged.insurance_claim_started, false);
  assert.equal(merged.insurance_status, "out_of_pocket");
  assert.equal(isFieldAskable("insurance_claim_started", merged), false);
});

test("opening silence controller waits while caller speech is active", () => {
  const controller = new OpeningSilenceController();
  controller.beginListeningForCallerName();
  controller.onCallerSpeechStarted();
  assert.equal(controller.isCallerSpeechActive(), true);
  assert.equal(controller.isListeningForReason(), true);
});
