import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { TurnTimingTracker } from "../src/bridge/turn-timing.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { EARLY_CALLER_NAME_QUESTION } from "../src/orchestrator/field-validation.js";
import {
  getSharedMissingFields,
  isCallerNameResolved,
  isSharedIntakeComplete,
} from "../src/orchestrator/required-intake.js";
import {
  mergeRealtimeCallerAnswer,
} from "../src/orchestrator/realtime-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";
import {
  COMPANY_TIMEZONE,
  parseScheduleSpeech,
  processScheduleCapture,
  SCHEDULE_PARSE_FALLBACK_PROMPT,
} from "../src/orchestrator/schedule-normalizer.js";

const JULY_20_2026 = new Date("2026-07-20T18:00:00.000Z");

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+15551234567",
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

test("missing caller name appears in shared missing fields gate", () => {
  const missing = getSharedMissingFields({
    problem_description: "hail damage",
  });

  assert.ok(missing.includes("callerName"));
});

test("volunteered valid name resolves callerName without re-asking", () => {
  const fields = mergeRealtimeCallerAnswer(
    { problem_description: "hail damage" },
    "My name is Beau and I'm calling about hail damage",
    "+15551234567",
  );

  assert.equal(isCallerNameResolved(fields), true);
  assert.equal(getSharedMissingFields(fields).includes("callerName"), false);
});

test("intake cannot reach summary while callerName is unresolved", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    appointment_preference: "July 21 at 2:00 PM",
    schedule_confirmed: true,
    photos_available: true,
    additional_notes_responded: true,
  };

  assert.ok(getSharedMissingFields(fields).includes("callerName"));
  assert.equal(isSharedIntakeComplete(fields), false);

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "No, that's all",
    conversationState: "awaiting_additional_notes",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.nextConversationState, "collecting_intake");
  assert.doesNotMatch(outcome.replyText, /Does all of that sound correct/i);
});

test("intro asks for caller name early after reason for calling", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage last night",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
  });

  assert.match(outcome.replyText, /Could I start with your name/i);
  assert.equal(EARLY_CALLER_NAME_QUESTION.includes("Could I start with your name"), true);
});

test("damage language cannot populate callerName", () => {
  const fields = mergeRealtimeCallerAnswer(
    { problem_description: "hail damage" },
    "hail damage",
    "+15551234567",
    { pendingQuestion: "caller_name" },
  );

  assert.equal(fields.full_name, undefined);
  assert.equal(isCallerNameResolved(fields), false);
});

test("tomorrow at two resolves and confirms schedule", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "John",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "Tomorrow at two",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.replyText, /July 21 at 2:00 PM/i);
  assert.match(outcome.replyText, /Is that correct/i);
  assert.notEqual(outcome.replyText.trim(), "");
});

test("schedule parsing failure produces clarification not silence", () => {
  const capture = processScheduleCapture(
    { appointment_preference_raw: "sometime maybe" },
    "sometime maybe",
    JULY_20_2026,
  );

  assert.match(capture.clarificationPrompt ?? "", /specific day and time/i);
});

test("parseScheduleSpeech handles thrown normalization safely", () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts = () => {
    throw new Error("forced date failure");
  };

  try {
    const parsed = parseScheduleSpeech("tomorrow at 2", JULY_20_2026, COMPANY_TIMEZONE);
    assert.equal(parsed.status, "needs_date_clarification");
    if (parsed.status === "needs_date_clarification") {
      assert.equal(parsed.prompt, SCHEDULE_PARSE_FALLBACK_PROMPT);
    }
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original;
  }
});

test("stale response lock is released safely", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  assert.equal(guard.isActiveResponse(), true);

  guard.prepareCallerTurnRecovery();
  assert.equal(guard.isActiveResponse(), false);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), true);
});

test("OpenAI response failure releases response lock", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  guard.onResponseFailed();
  assert.equal(guard.isActiveResponse(), false);
});

test("only one active assistant response maximum", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
});

test("turn timing exposes speech stopped to first audio delay", () => {
  const tracker = new TurnTimingTracker();
  tracker.beginTurn("CA123", 1);
  tracker.record("speech_stopped", "CA123", { turnId: 1 });
  tracker.record("first_audio_received", "CA123", { turnId: 1 });
  assert.equal(tracker.getSpeechStoppedToFirstAudioMs(), 0);
});

test("schedule confirmation returns to intake after yes", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "John",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
    emergency_or_active_leak: false,
    urgency: "standard",
    insurance_claim_started: false,
    appointment_preference: "July 21 at 2:00 PM",
    appointment_schedule_iso: "2026-07-21T19:00:00.000Z",
    schedule_confirmed: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "Yes",
    conversationState: "awaiting_schedule_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.notEqual(outcome.replyText.trim(), "");
  assert.notEqual(outcome.nextConversationState, "awaiting_schedule_confirmation");
});
