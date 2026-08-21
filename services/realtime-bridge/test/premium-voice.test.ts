import assert from "node:assert/strict";
import test from "node:test";

import { BANNED_ACKNOWLEDGMENT_PHRASES, AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { buildContextualMultiFieldAcknowledgment } from "../src/orchestrator/contextual-acknowledgment.js";
import { applyConversationInferences } from "../src/orchestrator/conversation-reasoning.js";
import { buildCorrectedFieldReadback } from "../src/orchestrator/field-scoped-correction.js";
import {
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "../src/orchestrator/multi-field-extraction.js";
import {
  appendAnythingElseNotes,
  mergeRealtimeCallerAnswer,
} from "../src/orchestrator/realtime-intake.js";
import {
  getMissingRequiredFields,
  getNextRequiredField,
} from "../src/orchestrator/required-intake.js";
import {
  REALTIME_ANYTHING_ELSE_QUESTION,
  buildClosingMessage,
  ensureSingleIntakeQuestion,
} from "../src/orchestrator/realtime-prompts.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import {
  buildSituationAwareIntakeReply,
  buildSituationAwarePrefix,
  speechMentionsActiveWater,
} from "../src/orchestrator/situation-acknowledgment.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const CALLER_PHONE = "+15551234567";

test("storm story with active water gets urgency-aware opening reply", () => {
  const speech =
    "Hey, I don't know if you guys can help me, but that storm last night ripped some shingles off the back of my house and now I've got a little water coming through upstairs.";

  const after = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE, {
    conversationState: "awaiting_opening_story",
    isFirstCallerTurn: true,
  });

  assert.equal(speechMentionsActiveWater(speech, after), true);

  const reply = buildSituationAwareIntakeReply({}, after, speech, "What's your name?", {
    isFirstStoryTurn: true,
  });

  assert.match(reply, /water coming in/i);
  assert.match(reply, /grab a few details/i);
  assert.match(reply, /What's your name/i);
  assert.doesNotMatch(reply, /Got it/i);
});

test("multi-field Sarah Miller example skips already captured questions", () => {
  const speech =
    "I'm Sarah Miller, I'm at 412 Lakeview Drive, and the roof is probably 20 years old. We lost some shingles last night.";

  const fields = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);
  const missing = getMissingRequiredFields(fields);

  assert.equal(fields.full_name, "Sarah Miller");
  assert.match(fields.address ?? "", /412 Lakeview Drive/i);
  assert.match(fields.problem_description ?? "", /shingles/i);
  assert.match(fields.additional_notes ?? "", /20 years old/i);
  assert.equal(missing.includes("full_name"), false);
  assert.equal(missing.includes("problem_description"), false);
  assert.equal(missing.includes("address"), false);
});

test("situation prefix responds to insurance not contacted", () => {
  const speech = "I haven't called insurance yet.";
  const after = mergeRealtimeCallerAnswer(
    { problem_description: "hail damage" },
    speech,
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim" },
  );

  const prefix = buildSituationAwarePrefix(
    { problem_description: "hail damage" },
    after,
    speech,
  );

  assert.match(prefix ?? "", /roofing team knows/i);
  assert.doesNotMatch(prefix ?? "", /Got it/i);
});

test("water intrusion gets contextual acknowledgment not generic filler", () => {
  const before: RealtimeFields = { problem_description: "hail damage" };
  const after: RealtimeFields = {
    ...before,
    emergency_or_active_leak: true,
  };

  const ack = buildContextualMultiFieldAcknowledgment(
    before,
    after,
    "Water is coming through the ceiling.",
  );

  assert.match(ack ?? "", /urgent/i);
  assert.doesNotMatch(ack ?? "", /Got it/i);
});

test("acknowledgment policy avoids banned filler phrases", () => {
  for (const phrase of BANNED_ACKNOWLEDGMENT_PHRASES) {
    assert.ok(phrase.length > 0);
  }

  const policy = new AcknowledgmentPolicy();
  const ack = policy.selectAcknowledgment({
    answer: "The kitchen ceiling is dripping and it's urgent.",
    filledCount: 2,
    nextField: "callback_phone",
    afterConfirmation: true,
  });

  if (ack) {
    for (const banned of BANNED_ACKNOWLEDGMENT_PHRASES) {
      assert.doesNotMatch(ack.toLowerCase(), new RegExp(banned));
    }
  }
});

test("intake reply contains at most one question mark", () => {
  const speech =
    "Storm last night tore shingles off and water is getting into the bedroom.";

  const after = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);
  const reply = buildSituationAwareIntakeReply({}, after, speech, "What's your name?", {
    isFirstStoryTurn: true,
  });

  assert.equal((reply.match(/\?/g) ?? []).length, 1);
});

test("urgency inferred from active leak in long answer", () => {
  const merged = mergeRealtimeCallerAnswer(
    {},
    "Water is pouring into the bedroom, it's urgent, and I can talk anytime after work tomorrow.",
    CALLER_PHONE,
  );

  assert.equal(merged.emergency_or_active_leak, true);
  assert.equal(merged.urgency, "emergency");
});

test("urgency inferred from approaching storm context", () => {
  const reasoned = applyConversationInferences({
    problem_description: "missing shingles and another storm is coming tomorrow",
  });

  assert.match(reasoned.urgency ?? "", /high/i);
});

test("correction readback for phone does not use Got it filler", () => {
  const readback = buildCorrectedFieldReadback("callback_phone", "+14025550187");
  assert.match(readback, /best number/i);
  assert.doesNotMatch(readback, /Got it/i);
});

test("confirmed address stays confirmed until explicit correction", () => {
  const fields: RealtimeFields = {
    address: "123 Main Street",
    address_confirmed: true,
    full_name: "Jane Doe",
    caller_first_name: "Jane",
    caller_last_name: "Doe",
    opening_name_complete: true,
    problem_description: "leak",
    callback_phone: CALLER_PHONE,
    callback_phone_confirmed: true,
    emergency_or_active_leak: false,
    insurance_claim_started: false,
  };

  const merged = mergeRealtimeCallerAnswer(
    fields,
    "Also the gutters are clogged.",
    CALLER_PHONE,
  );

  assert.equal(merged.address_confirmed, true);
  assert.match(merged.address ?? "", /123 Main Street/i);
});

test("anything else question uses natural roofing wording", () => {
  assert.match(REALTIME_ANYTHING_ELSE_QUESTION, /roof or property/i);
  assert.match(REALTIME_ANYTHING_ELSE_QUESTION, /Before I send this over/i);
});

test("final anything else response is captured in notes", () => {
  const base: RealtimeFields = {
    problem_description: "hail damage",
    additional_notes_responded: true,
  };

  const updated = appendAnythingElseNotes(
    base,
    "There's also a soft spot on the back porch.",
    CALLER_PHONE,
  );

  assert.match(updated.additional_notes ?? "", /soft spot/i);
});

test("closing message is personalized with caller first name", () => {
  const closing = buildClosingMessage({
    fields: {
      full_name: "Mike Thompson",
      caller_first_name: "Mike",
    },
  });

  assert.match(closing, /Mike/);
  assert.match(closing, /roofing team/i);
  assert.doesNotMatch(closing, /Does everything look/i);
});

test("complete intake after anything else can close without full phone summary", async () => {
  const complete: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    caller_first_name: "Beau",
    caller_last_name: "Spilker",
    opening_name_complete: true,
    callback_phone: CALLER_PHONE,
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    adjuster_contacted: false,
    appointment_preference: "July 21 at 2:00 PM",
    schedule_confirmed: true,
  };

  const outcome = await processRealtimeCallerTurn({
    session: {
      id: "session-1",
      twilio_call_sid: "CA123",
      company_id: "company-1",
      caller_phone: CALLER_PHONE,
      called_phone: "+14027611540",
      status: "active",
      current_question: REALTIME_ANYTHING_ELSE_QUESTION,
      collected_fields: complete,
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
    speechResult: "No, that's everything.",
    conversationState: "awaiting_additional_notes",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.equal(outcome.hangup, true);
  assert.equal(outcome.hangupAfterMark, true);
  assert.equal(
    (outcome.session?.collected_fields as RealtimeFields).summary_confirmed,
    true,
  );
  assert.doesNotMatch(outcome.replyText, /Does all of that sound correct/i);
});

test("insurance captured inside long multi-field answer", () => {
  const fields = mergeRealtimeCallerAnswer(
    {
      full_name: "John Smith",
      caller_first_name: "John",
      caller_last_name: "Smith",
      opening_name_complete: true,
      address: "123 Main Street",
      problem_description: "hail damage",
    },
    "Insurance hasn't come out yet.",
    CALLER_PHONE,
    { pendingQuestion: "insurance_claim", conversationState: "collecting_intake" },
  );

  assert.equal(fields.adjuster_contacted, false);
  assert.equal(fields.field_resolution?.insurance_claim_started, "captured");
});
