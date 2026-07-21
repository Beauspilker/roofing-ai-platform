import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { applyAddressCorrection } from "../src/orchestrator/address-confirmation.js";
import {
  buildCorrectionFollowUp,
  isRejectionOnlySpeech,
  markAddressCaptured,
  parseAddressCorrection,
  parseCallerNameCorrection,
  parseCallbackPhoneCorrection,
  parseScheduleCorrectionSpeech,
  requiresImmediateConfirmation,
  shouldReadBackAddressImmediately,
} from "../src/orchestrator/confirmation-correction.js";
import { applyCallbackCorrection } from "../src/orchestrator/realtime-intake.js";
import { applyPhotosPendingAnswer } from "../src/orchestrator/photos-field.js";
import { buildNameClarificationPrompt, validateCallerNameCandidate } from "../src/orchestrator/field-validation.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";

const mockSession = {
  id: "session-1",
  twilio_call_sid: "CA123",
  company_id: "company-1",
  caller_phone: "+14025551948",
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

const baseIntakeFields: RealtimeFields = {
  problem_description: "hail damage",
  full_name: "Bill",
  callback_phone: "+14025551948",
  callback_phone_confirmed: true,
  address: "123 Maple Street, Beatrice, Nebraska",
  address_confirmed: true,
  emergency_or_active_leak: false,
  insurance_claim_started: false,
  adjuster_contacted: false,
};

test("name confirmation stores corrected name without rejection word", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    name_pending_confirmation: "Bill",
    pending_question: "caller_name",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "No, Beau.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  const stored = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(stored.full_name, "Beau");
  assert.doesNotMatch(stored.full_name ?? "", /\bno\b/i);
});

test("standalone no to name confirmation keeps name pending and asks focused follow-up", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    name_pending_confirmation: "Bill",
    pending_question: "caller_name",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "No",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  const stored = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(stored.full_name, undefined);
  assert.match(outcome.replyText, /correct name/i);
  assert.equal(buildCorrectionFollowUp("caller_name"), outcome.replyText.trim());
});

test("address confirmation stores corrected address without no prefix", async () => {
  const corrected = applyAddressCorrection(
    { address: "123 Maple Street", address_confirmed: false },
    "No, 456 Main Street.",
  );

  assert.match(corrected.address ?? "", /456 Main Street/i);
  assert.doesNotMatch(corrected.address ?? "", /\bno\b/i);
});

test("callback correction from ends-in phrase stores corrected phone and reconfirms", async () => {
  const fields: RealtimeFields = {
    callback_phone: "+14025551234",
    callback_phone_confirmed: false,
    pending_question: "callback_confirmation",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "No, it ends in 1948",
    conversationState: "awaiting_callback_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  const stored = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(stored.callback_phone, "+14025551948");
  assert.match(outcome.replyText, /402-555-1948/);
  assert.match(outcome.replyText, /Is that correct\?/);
});

test("schedule confirmation stores only corrected date/time speech", () => {
  assert.equal(parseScheduleCorrectionSpeech("No, tomorrow at two."), "tomorrow at two.");
});

test("rejection-only speech never becomes field values", () => {
  assert.equal(parseCallerNameCorrection("no"), null);
  assert.equal(parseAddressCorrection("nope"), null);
  assert.equal(parseCallbackPhoneCorrection("no"), null);
  assert.equal(parseScheduleCorrectionSpeech("no"), "");
  assert.equal(isRejectionOnlySpeech("no"), true);
});

test("damage reason is not immediately confirmed", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Hail damage.",
    conversationState: "listening_for_reason",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  assert.doesNotMatch(outcome.replyText, /Is that correct/i);
  assert.doesNotMatch(outcome.replyText, /I heard hail damage/i);
});

test("insurance yes/no is not immediately confirmed", async () => {
  const fields: RealtimeFields = {
    ...baseIntakeFields,
    pending_question: "insurance_claim",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Yes",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.doesNotMatch(outcome.replyText, /Is that correct/i);
  assert.doesNotMatch(outcome.replyText, /I heard yes/i);
  assert.equal(outcome.session?.collected_fields.insurance_claim_started, true);
});

test("pictures yes/no is not immediately confirmed", async () => {
  const fields: RealtimeFields = {
    ...baseIntakeFields,
    insurance_claim_started: true,
    adjuster_contacted: true,
    pending_question: "photos_available",
  };

  const stored = applyPhotosPendingAnswer(fields, "Yes, I have pictures.", "photos_available");
  assert.equal(stored.photos_available, true);

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Yes, I have pictures.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.doesNotMatch(outcome.replyText, /Is that correct/i);
  assert.doesNotMatch(outcome.replyText, /I heard yes/i);
});

test("damage description follow-up is not immediately confirmed", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    callback_phone: "+14025551948",
    callback_phone_confirmed: true,
    address: "456 Oak Avenue, Beatrice, Nebraska",
    address_confirmed: true,
    emergency_or_active_leak: false,
    pending_question: "urgency",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "It's pretty urgent, shingles are missing.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.doesNotMatch(outcome.replyText, /Is that correct/i);
  assert.doesNotMatch(outcome.replyText, /I heard .*missing/i);
});

test("callback number is confirmed once when first captured", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "402-555-5678",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.replyText, /402-555-5678/);
  assert.match(outcome.replyText, /Is that correct\?/);
  assert.equal(outcome.nextConversationState, "awaiting_callback_confirmation");
  assert.equal(requiresImmediateConfirmation("callback_phone"), true);
});

test("exact appointment date/time is confirmed once", async () => {
  const fields: RealtimeFields = {
    ...baseIntakeFields,
    appointment_preference: "Wednesday, July 22 at 2:00 PM",
    schedule_confirmed: false,
    pending_question: "schedule_confirmation",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Yes",
    conversationState: "awaiting_schedule_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.equal(outcome.session?.collected_fields.schedule_confirmed, true);
  assert.equal(requiresImmediateConfirmation("schedule_confirmation"), true);
});

test("low-confidence name receives focused clarification", async () => {
  assert.equal(
    validateCallerNameCandidate("roof damage", { isDirectNameAnswer: true }).needsClarification,
    true,
  );
  assert.match(buildNameClarificationPrompt(), /didn't catch your name/i);

  const fields: RealtimeFields = {
    problem_description: "hail damage",
    name_needs_clarification: true,
    name_clarification_attempts: 1,
    pending_question: "caller_name",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "roof damage",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.replyText, /didn't catch your name|say it one more time|spell your name/i);
  assert.equal(outcome.session?.collected_fields.full_name, undefined);
  assert.equal(requiresImmediateConfirmation("caller_name", fields), true);
});

test("ambiguous address receives immediate readback confirmation", () => {
  const captured = markAddressCaptured({}, "123 Main Street in Beatrice");
  assert.equal(captured.address_needs_confirmation, true);
  assert.equal(shouldReadBackAddressImmediately(captured), true);
});

test("unclear answers do not reset completed fields", async () => {
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
    callback_phone: "+14025551948",
    callback_phone_confirmed: true,
    name_needs_clarification: true,
    name_clarification_attempts: 1,
    pending_question: "caller_name",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "uh",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  const stored = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(stored.full_name, "Beau Spilker");
  assert.equal(stored.callback_phone, "+14025551948");
  assert.equal(stored.callback_phone_confirmed, true);
  assert.match(stored.problem_description ?? "", /hail damage/i);
});

test("applyCallbackCorrection strips rejection prefix from corrected number", () => {
  const corrected = applyCallbackCorrection(
    { callback_phone: "+14025551234", callback_phone_confirmed: false },
    "No, 402-555-5678",
    "+14025551948",
  );

  assert.equal(corrected.callback_phone, "+14025555678");
});

test("address correction during confirmation does not keep rejection prefix", async () => {
  const fields: RealtimeFields = {
    address: "123 Maple Street",
    address_confirmed: false,
    pending_question: "address_confirmation",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "No, 456 Main Street in Beatrice",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.session?.collected_fields.address ?? "", /456 Main Street/i);
  assert.doesNotMatch(outcome.session?.collected_fields.address ?? "", /\bno\b/i);
});
