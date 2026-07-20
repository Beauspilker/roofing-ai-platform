import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { buildRealtimeSessionUpdate } from "../src/openai/realtime-session.js";
import { blocksAutomatedClosing, CLOSING_MESSAGE } from "../src/orchestrator/conversation-state.js";
import {
  mergeRealtimeCallerAnswer,
  toPersistedFields,
} from "../src/orchestrator/realtime-intake.js";
import {
  buildClosingMessage,
  buildStructuredSpokenSummary,
  buildSummaryWithConfirmation,
  ensureSingleIntakeQuestion,
  REALTIME_OPENING_GREETING,
  type RealtimeFields,
} from "../src/orchestrator/realtime-prompts.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import {
  applyCorrectionToStructuredField,
  applyStructuredBoolean,
  parseExplicitBoolean,
} from "../src/orchestrator/structured-intake.js";
import { DEFAULT_OPENAI_REALTIME_VOICE } from "../../../lib/twilio/voice-mode.js";
import {
  DEFAULT_COMPANY_PHONE_E164,
  getCompanyPhoneE164,
} from "../../../lib/twilio/company-phone.js";

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+15551234567",
  called_phone: DEFAULT_COMPANY_PHONE_E164,
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

test("cedar is selected in initial session config before any response", () => {
  const update = buildRealtimeSessionUpdate("cedar");

  assert.equal(update.session.audio.output.voice, "cedar");
  assert.match(update.session.instructions, /lower-pitched male receptionist/i);
  assert.equal(update.session.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(update.session.audio.input.turn_detection.eagerness, "medium");
  assert.equal(DEFAULT_OPENAI_REALTIME_VOICE, "cedar");
});

test("ResponseStateGuard allows only one active response", () => {
  const guard = new ResponseStateGuard();

  assert.equal(guard.canTriggerResponse("opening_greeting"), true);
  guard.recordTrigger("opening_greeting");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isActiveResponse(), true);

  guard.onResponseDone();
  assert.equal(guard.isActiveResponse(), false);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isWaitingForCaller(), true);
});

test("ensureSingleIntakeQuestion keeps only the first question", () => {
  const reply = ensureSingleIntakeQuestion(
    "Got it. What's your name? And what's the address?",
  );

  assert.equal(reply, "Got it. What's your name?");
});

test("explicit insurance no remains false through summary", () => {
  let fields: RealtimeFields = {};

  fields = mergeRealtimeCallerAnswer(fields, "My roof is leaking", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "Beau Spilker", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "Yes", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "123 Main St", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "Repair", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "No", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "No", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "No, I haven't started a claim", "+15551234567");

  assert.equal(fields.insurance_claim_started, false);

  const summary = buildStructuredSpokenSummary(fields);
  assert.match(summary, /You haven't started an insurance claim yet\./);
  assert.doesNotMatch(summary, /You've already started an insurance claim\./);
});

test("not yet parses as false and stays false in summary", () => {
  const fields = applyStructuredBoolean({}, "insurance_claim_started", "Not yet", {
    isDirectAnswer: true,
  });

  assert.equal(fields.insurance_claim_started, false);
  assert.equal(parseExplicitBoolean("Not yet"), false);

  const summary = buildStructuredSpokenSummary(fields);
  assert.match(summary, /You haven't started an insurance claim yet\./);
});

test("later explicit correction can change false to true", () => {
  let fields: RealtimeFields = { insurance_claim_started: false };

  fields = applyCorrectionToStructuredField(fields, "Actually yes, I did start a claim");

  assert.equal(fields.insurance_claim_started, true);
  assert.match(
    buildStructuredSpokenSummary(fields),
    /You've already started an insurance claim\./,
  );
});

test("unrelated later statements cannot change confirmed boolean", () => {
  let fields: RealtimeFields = { insurance_claim_started: false };

  fields = applyCorrectionToStructuredField(fields, "The storm was last Tuesday");

  assert.equal(fields.insurance_claim_started, false);
});

test("summary confirmation does not include closing in the same response", async () => {
  const fields: RealtimeFields = {
    problem_description: "a leak",
    full_name: "Beau",
    insurance_claim_started: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No, that's all",
    conversationState: "awaiting_additional_notes",
  });

  assert.match(outcome.replyText, /Does all of that sound correct\?/);
  assert.doesNotMatch(outcome.replyText, /Perfect\. I'll send this information/);
  assert.equal(outcome.hangupAfterMark, false);
  assert.equal(outcome.nextConversationState, "presenting_summary");
});

test("assistant waits for answer after summary confirmation question", async () => {
  const fields: RealtimeFields = {
    problem_description: "a leak",
    insurance_claim_started: false,
  };

  const summaryOutcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No",
    conversationState: "awaiting_additional_notes",
  });

  assert.equal(summaryOutcome.nextConversationState, "presenting_summary");
  assert.equal(summaryOutcome.hangupAfterMark, false);

  const silentOutcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "",
    conversationState: "awaiting_summary_confirmation",
  });

  assert.equal(silentOutcome.replyText, "");
  assert.equal(silentOutcome.hangupAfterMark, false);
  assert.equal(silentOutcome.nextConversationState, "awaiting_summary_confirmation");
});

test("silence does not trigger closing", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "",
    conversationState: "awaiting_summary_confirmation",
  });

  assert.equal(outcome.replyText, "");
  assert.equal(outcome.hangup, false);
  assert.equal(outcome.hangupAfterMark, false);
});

test("correction updates structured state and asks reconfirmation", async () => {
  const fields: RealtimeFields = {
    insurance_claim_started: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No, I actually did start a claim",
    conversationState: "awaiting_summary_confirmation",
  });

  assert.equal(outcome.session?.collected_fields.insurance_claim, "yes");
  assert.match(outcome.replyText, /Does that sound correct now\?/);
  assert.equal(outcome.hangupAfterMark, false);
  assert.equal(outcome.nextConversationState, "awaiting_summary_confirmation");
});

test("confirmation yes returns closing only in a separate turn", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { insurance_claim_started: false, insurance_claim: "no" },
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Yes, that's correct",
    conversationState: "awaiting_summary_confirmation",
  });

  assert.equal(outcome.replyText, CLOSING_MESSAGE);
  assert.equal(outcome.hangupAfterMark, true);
  assert.equal(outcome.nextConversationState, "delivering_closing");
  assert.equal(blocksAutomatedClosing("awaiting_summary_confirmation"), true);
});

test("closing message matches required wording", () => {
  assert.equal(buildClosingMessage(), CLOSING_MESSAGE);
  assert.match(CLOSING_MESSAGE, /someone will follow up with you by call or text/);
  assert.doesNotMatch(CLOSING_MESSAGE, /761-1540/);
});

test("ResponseStateGuard blocks duplicate closing triggers while awaiting mark", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("closing_message");
  guard.beginClosingMarkWait();

  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.canTriggerResponse("closing_message"), false);
});

test("company phone number source of truth is +14027611540", () => {
  delete process.env.TWILIO_PHONE_NUMBER;

  assert.equal(getCompanyPhoneE164(), DEFAULT_COMPANY_PHONE_E164);
  assert.equal(DEFAULT_COMPANY_PHONE_E164, "+14027611540");
});

test("customer callback number remains separate from company number", () => {
  const fields: RealtimeFields = {
    callback_phone: "+15559876543",
  };

  const persisted = toPersistedFields(fields);

  assert.equal(persisted.callback_phone, "+15559876543");
  assert.notEqual(persisted.callback_phone, getCompanyPhoneE164());
  assert.notEqual(mockSession.caller_phone, getCompanyPhoneE164());
});

test("buildSummaryWithConfirmation uses structured insurance wording", () => {
  const summary = buildSummaryWithConfirmation({
    insurance_claim_started: false,
  });

  assert.match(summary, /You haven't started an insurance claim yet\./);
  assert.match(summary, /Does all of that sound correct\?/);
});

test("opening greeting waits for caller and contains no intake fields", () => {
  assert.equal(
    REALTIME_OPENING_GREETING,
    "Thanks for calling Beau's Roofing. How can I help you today?",
  );
  assert.equal(ensureSingleIntakeQuestion(REALTIME_OPENING_GREETING).includes("name"), false);
  assert.equal(ensureSingleIntakeQuestion(REALTIME_OPENING_GREETING).includes("address"), false);
});
