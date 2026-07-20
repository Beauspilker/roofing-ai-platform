import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { TurnTimingTracker } from "../src/bridge/turn-timing.js";
import { buildRealtimeSessionUpdate } from "../src/openai/realtime-session.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
import {
  applyPhotosPendingAnswer,
  isPhotosFieldComplete,
  isPhotosResolved,
  parsePhotosAnswerWhenPending,
} from "../src/orchestrator/photos-field.js";
import { getMissingRequiredFields } from "../src/orchestrator/required-intake.js";
import { needsCallbackConfirmation } from "../src/orchestrator/pending-question.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const baseFields: RealtimeFields = {
  problem_description: "hail damage",
  full_name: "Beau",
  callback_phone: "+14025551234",
  callback_phone_confirmed: true,
  address: "123 Main Street, Beatrice",
  address_confirmed: true,
  emergency_or_active_leak: false,
  urgency: "standard",
  insurance_claim_started: false,
  appointment_preference: "July 21 at 2:00 PM",
  schedule_confirmed: true,
  pending_question: "photos_available",
};

test("pending photos yes resolves photos and clears pending question", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.photos_available, true);
  assert.equal(isPhotosResolved(merged.photos_available ?? null), true);
  assert.equal(merged.pending_question, undefined);
});

test("pending photos no resolves without repeat", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "No", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.photos_available, false);
  assert.equal(getMissingRequiredFields(merged).includes("photos_available"), false);
});

test("pending photos not sure resolves as unknown", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Not sure", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.photos_available, "unknown");
  assert.equal(isPhotosFieldComplete(merged), true);
});

test("pending photos declined resolves as declined", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "I'd rather not say", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.photos_available, "declined");
  assert.equal(isPhotosFieldComplete(merged), true);
});

test("photos yes does not reopen callback confirmation", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.callback_phone_confirmed, true);
  assert.equal(needsCallbackConfirmation(merged), false);
});

test("photos yes does not reopen address confirmation", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.address_confirmed, true);
});

test("confirmed phone stays confirmed after unrelated photos answer", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.callback_phone_confirmed, true);
});

test("confirmed address stays confirmed after unrelated photos answer", () => {
  const merged = mergeRealtimeCallerAnswer(baseFields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  assert.equal(merged.address_confirmed, true);
});

test("missing-field selector skips resolved photos", () => {
  const resolved = applyPhotosPendingAnswer(baseFields, "Yes", "photos_available");
  assert.equal(getMissingRequiredFields(resolved).includes("photos_available"), false);
});

test("short yes maps using pendingQuestion not caller name", () => {
  assert.equal(parsePhotosAnswerWhenPending("yes", "photos_available"), true);
  const merged = mergeRealtimeCallerAnswer(baseFields, "yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });
  assert.equal(merged.full_name, "Beau");
  assert.equal(merged.photos_available, true);
});

test("only one assistant response is created per caller turn", () => {
  const guard = new ResponseStateGuard();
  guard.recordTrigger("caller_turn_reply");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  guard.onResponseDone();
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  guard.registerCallerTranscript("item-1");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), true);
});

test("response timing config uses server vad in target silence range", () => {
  const update = buildRealtimeSessionUpdate("cedar", {
    turnDetectionSilenceDurationMs: 750,
    turnDetectionPrefixPaddingMs: 200,
    turnDetectionThreshold: 0.5,
  } as never);

  assert.equal(update.session.audio.input.turn_detection.type, "server_vad");
  assert.equal(update.session.audio.input.turn_detection.silence_duration_ms, 750);
  assert.equal(update.session.audio.input.turn_detection.prefix_padding_ms, 200);
});

test("turn timing exposes speech-to-audio delay measurement", () => {
  const tracker = new TurnTimingTracker();
  tracker.beginTurn("CA123");
  tracker.record("speech_stopped", "CA123");
  tracker.record("transcript_completed", "CA123");
  tracker.record("structured_state_updated", "CA123");
  tracker.record("response_requested", "CA123");
  tracker.record("first_audio_received", "CA123");
  assert.equal(tracker.getSpeechStoppedToFirstAudioMs(), 0);
});

test("resolved photos are not asked again on next intake reply", async () => {
  const policy = new AcknowledgmentPolicy();
  let fields: RealtimeFields = { ...baseFields };

  fields = mergeRealtimeCallerAnswer(fields, "Yes", "+14025551234", {
    pendingQuestion: "photos_available",
  });

  const outcome = await processRealtimeCallerTurn({
    session: {
      id: "session-1",
      twilio_call_sid: "CA123",
      company_id: "company-1",
      caller_phone: "+14025551234",
      called_phone: "+14027611540",
      status: "active",
      current_question: "Do you have photos of the damage?",
      collected_fields: fields,
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
    callerPhone: "+14025551234",
    speechResult: "Yes",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.doesNotMatch(outcome.replyText, /Do you have photos/i);
});

test("photos yes adds brief acknowledgment before next question", async () => {
  const policy = new AcknowledgmentPolicy();
  const before: RealtimeFields = { ...baseFields, photos_available: null };

  const outcome = await processRealtimeCallerTurn({
    session: {
      id: "session-1",
      twilio_call_sid: "CA123",
      company_id: "company-1",
      caller_phone: "+14025551234",
      called_phone: "+14027611540",
      status: "active",
      current_question: "Do you have photos of the damage?",
      collected_fields: before,
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
    callerPhone: "+14025551234",
    speechResult: "Yes",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.replyText, /send those safely after the call/i);
});
