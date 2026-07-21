import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { TurnTimingTracker } from "../src/bridge/turn-timing.js";
import { buildRealtimeSessionUpdate } from "../src/openai/realtime-session.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  getMissingRequiredFields,
  getNextRequiredField,
  needsImmediateSafetyClarification,
} from "../src/orchestrator/required-intake.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
import {
  buildValidatedSpokenSummary,
} from "../src/orchestrator/summary-builder.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

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

test("hail damage without name selects caller_name next", () => {
  const fields: RealtimeFields = { problem_description: "hail damage" };
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.ok(getMissingRequiredFields(fields).includes("full_name"));
});

test("hail damage with volunteered name does not ask again", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My name is Beau and we had hail damage",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /Could I start with your name/i);
});

test("immediate safety issue is handled before caller name", async () => {
  const policy = new AcknowledgmentPolicy();
  assert.equal(
    needsImmediateSafetyClarification({
      problem_description: "Water is pouring in through the ceiling",
    }),
    true,
  );

  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Water is pouring in through the ceiling",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.match(outcome.replyText, /active leak|water getting inside/i);
  assert.doesNotMatch(outcome.replyText, /Could I start with your name/i);
});

test("caller name is prioritized before callback address insurance and scheduling", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    emergency_or_active_leak: false,
  };

  assert.equal(getNextRequiredField(fields), "full_name");

  const afterName: RealtimeFields = {
    ...fields,
    full_name: "Beau Spilker",
  };

  assert.equal(getNextRequiredField(afterName), "callback_phone");
});

test("photos are never selected as pending question", () => {
  const pending = resolvePendingQuestion(
    {
      problem_description: "hail damage",
      full_name: "Beau",
      callback_phone: "+14025551234",
      callback_phone_confirmed: true,
      address: "123 Main Street",
      address_confirmed: true,
      emergency_or_active_leak: false,
      urgency: "standard",
      insurance_claim_started: false,
      appointment_preference: "July 21 at 2 PM",
      schedule_confirmed: true,
      photos_available: null,
    },
    "collecting_intake",
  );

  assert.notEqual(pending, "photos_available");
});

test("photos do not appear in missing required fields", () => {
  const missing = getMissingRequiredFields({ problem_description: "hail damage" });
  assert.equal(
    missing.some((field) => (field as string) === "photos_available"),
    false,
  );
});

test("photos do not block final summary", () => {
  const { summary, issues } = buildValidatedSpokenSummary({
    full_name: "Beau Spilker",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    problem_description: "hail damage",
    emergency_or_active_leak: false,
    insurance_claim_started: false,
    appointment_preference: "tomorrow afternoon",
    schedule_confirmed: true,
    photos_available: null,
    additional_notes_responded: true,
  });

  assert.match(summary, /Beau Spilker/i);
  assert.equal(issues.length, 0);
});

test("photos are omitted from spoken summary", () => {
  const { summary } = buildValidatedSpokenSummary({
    full_name: "Beau Spilker",
    callback_phone: "+14025550198",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice",
    address_confirmed: true,
    problem_description: "hail damage",
    photos_available: true,
  });

  assert.doesNotMatch(summary, /photos/i);
});

test("stored photos_available remains backward compatible without affecting intake", () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau",
    photos_available: true,
  };

  assert.equal(getNextRequiredField(fields), "callback_phone");
});

test("response guard releases stale lock after failure", () => {
  const guard = new ResponseStateGuard();
  guard.registerCallerTranscript("item-1");
  guard.recordTrigger("caller_turn_reply", 3);
  guard.onResponseFailed();
  assert.equal(guard.isActiveResponse(), false);
  guard.prepareCallerTurnRecovery();
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), true);
});

test("turn timing records all stages with turn id", () => {
  const tracker = new TurnTimingTracker();
  tracker.beginTurn("CA123", 1);
  tracker.record("speech_stopped", "CA123", { turnId: 1 });
  tracker.record("transcript_completed", "CA123", { turnId: 1 });
  tracker.record("caller_turn_processed", "CA123", { turnId: 1 });
  tracker.record("structured_state_updated", "CA123", { turnId: 1 });
  tracker.record("next_question_selected", "CA123", { turnId: 1 });
  tracker.record("response_requested", "CA123", { turnId: 1 });
  tracker.record("response_create_sent", "CA123", { turnId: 1 });
  tracker.record("first_audio_received", "CA123", { turnId: 1 });
  tracker.record("first_audio_sent_to_twilio", "CA123", { turnId: 1 });
  assert.equal(tracker.getSpeechStoppedToFirstAudioMs(), 0);
});

test("stale turn milestones are ignored", () => {
  const tracker = new TurnTimingTracker();
  tracker.beginTurn("CA123", 2);
  tracker.record("first_audio_received", "CA123", { turnId: 1 });
  assert.equal(tracker.hasFirstAudio(), false);
});

test("response timing config uses server_vad between 500 and 700 ms", () => {
  const base = {
    turnDetectionPrefixPaddingMs: 250,
    turnDetectionThreshold: 0.5,
  } as never;

  assert.equal(
    buildRealtimeSessionUpdate("cedar", { ...base, turnDetectionSilenceDurationMs: 600 })
      .session.audio.input.turn_detection.silence_duration_ms,
    600,
  );
  assert.equal(
    buildRealtimeSessionUpdate("cedar", { ...base, turnDetectionSilenceDurationMs: 400 })
      .session.audio.input.turn_detection.silence_duration_ms,
    500,
  );
  assert.equal(
    buildRealtimeSessionUpdate("cedar", { ...base, turnDetectionSilenceDurationMs: 900 })
      .session.audio.input.turn_detection.silence_duration_ms,
    700,
  );
  assert.equal(
    buildRealtimeSessionUpdate("cedar", { ...base, turnDetectionSilenceDurationMs: 600 })
      .session.audio.input.turn_detection.prefix_padding_ms,
    250,
  );
});

test("only one active assistant response maximum", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply", 1);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
});

test("response guard tracks turn ids for stale audio detection", () => {
  const guard = new ResponseStateGuard();
  guard.beginCallerTurn(2);
  guard.recordTrigger("caller_turn_reply", 1);
  assert.equal(guard.isStaleResponseAudio(2), true);
  assert.equal(guard.isStaleResponseAudio(1), false);
});
