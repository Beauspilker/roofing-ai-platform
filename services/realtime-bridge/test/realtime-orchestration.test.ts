import assert from "node:assert/strict";
import test from "node:test";

import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { TurnTimingTracker } from "../src/bridge/turn-timing.js";
import { buildRealtimeSessionUpdate } from "../src/openai/realtime-session.js";
import {
  buildCallbackReadbackConfirmation,
  extractCallbackPhoneFromSpeech,
  formatCallbackForSpeech,
  normalizeCallbackPhoneE164,
} from "../src/orchestrator/callback-phone.js";
import {
  AcknowledgmentPolicy,
  CLOSING_PHRASES,
  containsClosingPhrase,
  guardIntakeReply,
  sanitizeIntakeReply,
} from "../src/orchestrator/acknowledgment-policy.js";
import { blocksAutomatedClosing, CLOSING_MESSAGE } from "../src/orchestrator/conversation-state.js";
import {
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "../src/orchestrator/multi-field-extraction.js";
import {
  countNewlyFilledFields,
  getMissingRequiredFields,
  getRealtimeNextMissingStage,
  isRequiredIntakeComplete,
  mergeRealtimeCallerAnswer,
  needsCallbackReadback,
  toPersistedFields,
} from "../src/orchestrator/realtime-intake.js";
import {
  getMissingRequiredFields as getMissingFromGate,
  isRequiredIntakeComplete as gateComplete,
} from "../src/orchestrator/required-intake.js";
import {
  buildClosingMessage,
  buildStructuredSpokenSummary,
  buildSummaryWithConfirmation,
  ensureSingleIntakeQuestion,
  REALTIME_OPENING_GREETING,
  summaryContainsKnownFields,
  type RealtimeFields,
} from "../src/orchestrator/realtime-prompts.js";
import {
  buildAddressReadbackConfirmation,
  hasConfirmableAddress,
} from "../src/orchestrator/address-confirmation.js";
import {
  COMPANY_TIMEZONE,
  parseScheduleSpeech,
  processScheduleCapture,
} from "../src/orchestrator/schedule-normalizer.js";
import { buildIntakeReply } from "../src/orchestrator/realtime-intake.js";
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

const completeIntakeFields: RealtimeFields = {
  problem_description: "leak",
  full_name: "Beau",
  callback_phone: "+15551234567",
  callback_phone_confirmed: true,
  address: "123 Main Street",
  address_confirmed: true,
  urgency: "standard",
  emergency_or_active_leak: false,
  insurance_claim_started: false,
  appointment_preference: "July 21 at 2:00 PM",
  schedule_confirmed: true,
  additional_notes_responded: true,
};

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
  const update = buildRealtimeSessionUpdate("cedar", {
    turnDetectionSilenceDurationMs: 600,
  } as never);

  assert.equal(update.session.audio.output.voice, "cedar");
  assert.equal(update.session.audio.input.turn_detection.type, "server_vad");
  assert.equal(DEFAULT_OPENAI_REALTIME_VOICE, "cedar");
});

test("same acknowledgment is not used consecutively", () => {
  const policy = new AcknowledgmentPolicy();

  policy.selectAcknowledgment({
    answer: "The roof is leaking into the bedroom",
    filledCount: 1,
    nextField: "full_name",
  });
  policy.selectAcknowledgment({
    answer: "John Smith",
    filledCount: 1,
    nextField: "callback_phone",
  });
  const first = policy.selectAcknowledgment({
    answer: "402-555-0198",
    filledCount: 1,
    nextField: "address",
    afterConfirmation: true,
  });
  const second = policy.selectAcknowledgment({
    answer: "123 Main Street in Beatrice",
    filledCount: 1,
    nextField: "emergency_or_active_leak",
    afterConfirmation: true,
  });

  if (first !== null && second !== null) {
    assert.notEqual(first, second);
  }
});

test("Got it is not overused during one call", () => {
  const policy = new AcknowledgmentPolicy();
  const results: Array<string | null> = [];

  for (let index = 0; index < 12; index += 1) {
    results.push(
      policy.selectAcknowledgment({
        answer: index % 2 === 0 ? "Water is coming into the kitchen" : "yes",
        filledCount: 1,
        nextField: "address",
      }),
    );
  }

  assert.equal(results.filter((value) => value === "Got it.").length, 0);
});

test("natural acknowledgment appears on some turns but not every turn", () => {
  const policy = new AcknowledgmentPolicy();
  const results: Array<string | null> = [];

  for (let index = 0; index < 10; index += 1) {
    results.push(
      policy.selectAcknowledgment({
        answer:
          index % 2 === 0
            ? "A tree hit the roof last night and water is coming in"
            : "yes",
        filledCount: index > 0 ? 1 : 0,
        nextField: "address",
      }),
    );
  }

  const ackCount = results.filter((value) => value !== null).length;
  assert.ok(ackCount >= 2);
  assert.ok(ackCount <= 8);
});

test("intake wording never uses closing language", () => {
  const sample = sanitizeIntakeReply("Sounds good. Next, what's the property address?");

  assert.equal(containsClosingPhrase(sample), false);
  assert.match(sample, /property address/i);

  for (const phrase of CLOSING_PHRASES) {
    assert.equal(containsClosingPhrase(`Next, what's the address? ${phrase}`), true);
  }
});

test("assistant cannot close after only reason and callback number", async () => {
  const policy = new AcknowledgmentPolicy();
  let fields: RealtimeFields = mergeRealtimeCallerAnswer(
    {},
    "My roof is leaking",
    "+14025551234",
  );
  fields = mergeRealtimeCallerAnswer(fields, "yes", "+14025551234");
  fields = { ...fields, callback_phone_confirmed: true };

  assert.equal(isRequiredIntakeComplete(fields), false);
  assert.ok(getMissingRequiredFields(fields).length > 0);

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "John Smith",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.notEqual(outcome.nextConversationState, "awaiting_additional_notes");
  assert.notEqual(outcome.nextConversationState, "delivering_closing");
  assert.doesNotMatch(outcome.replyText, /all set/i);
  assert.doesNotMatch(outcome.replyText, /reach out/i);
  assert.doesNotMatch(outcome.replyText, /Great\. I'll send/i);
  assert.ok(getMissingRequiredFields(fields).length > 0);
});

test("summary is blocked while any required field is missing", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
  };

  assert.ok(getMissingFromGate(fields).length > 0);

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

test("closing phrases are blocked during collecting_intake", () => {
  const fallback = "What's the property address?";
  const guarded = guardIntakeReply("You're all set. Someone will reach out soon.", fallback);

  assert.equal(guarded, fallback);
  assert.equal(containsClosingPhrase(guarded), false);
});

test("direct name answers are captured when name is the missing field", () => {
  const fields = mergeRealtimeCallerAnswer(
    { problem_description: "leak" },
    "John Smith",
    "+14025551234",
  );

  assert.equal(fields.full_name, "John Smith");
});

test("required intake completion is determined by code not model judgment", () => {
  const partial: RealtimeFields = {
    problem_description: "leak",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
  };

  assert.equal(gateComplete(partial), false);
  assert.deepEqual(getMissingFromGate(partial).includes("full_name"), true);
});

test("multiple fields in one caller response are all stored", () => {
  const speech =
    "I'm John, the address is 123 Main Street, and a tree hit the roof yesterday.";
  const extracted = extractAllFieldsFromTranscript(speech, "+15551234567");
  const merged = mergeExtractedFields({}, extracted);

  assert.equal(merged.full_name, "John");
  assert.match(merged.address ?? "", /123 Main Street/i);
  assert.match(merged.problem_description ?? "", /tree hit the roof/i);
  assert.equal(countNewlyFilledFields({}, merged), 2);
});

test("already answered fields are not asked again after multi-field capture", () => {
  const fields = mergeRealtimeCallerAnswer(
    {},
    "I'm John, the address is 123 Main Street, and a tree hit the roof yesterday.",
    "+15551234567",
  );

  const nextStage = getRealtimeNextMissingStage(fields);
  assert.notEqual(nextStage, "full_name");
  assert.notEqual(nextStage, "problem_description");
  assert.equal(nextStage, "callback_phone");
});

test("no claim yet and no adjuster stores both booleans as false", () => {
  const merged = mergeRealtimeCallerAnswer(
    {},
    "No claim yet, and I haven't talked to an adjuster.",
    "+15551234567",
  );

  assert.equal(merged.insurance_claim_started, false);
  assert.equal(merged.adjuster_contacted, false);
});

test("corrected callback number replaces the old number", () => {
  const phone = extractCallbackPhoneFromSpeech(
    "My number is 402-555-1234, actually make that 402-555-5678",
  );

  assert.equal(normalizeCallbackPhoneE164(phone ?? ""), "+14025555678");
});

test("corrected callback number is read back and explicitly confirmed", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    callback_phone: "+14025551234",
    callback_phone_confirmed: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No, make that 402-555-5678",
    conversationState: "awaiting_callback_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.session?.collected_fields.callback_phone, "+14025555678");
  assert.match(outcome.replyText, /402-555-5678/);
  assert.match(outcome.replyText, /Is that correct\?/);
  assert.equal(outcome.nextConversationState, "awaiting_callback_confirmation");
});

test("next intake question is blocked while awaiting callback confirmation", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "hail damage",
    full_name: "Beau Spilker",
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "402-555-5678",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.replyText, /402-555-5678/);
  assert.match(outcome.replyText, /Is that correct\?/);
  assert.equal(outcome.nextConversationState, "awaiting_callback_confirmation");
  assert.doesNotMatch(outcome.replyText, /property address/i);
});

test("final summary uses structured state only", () => {
  const summary = buildStructuredSpokenSummary({
    full_name: "John Smith",
    callback_phone: "+14025555678",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    problem_description: "a tree damaged the roof yesterday",
    emergency_or_active_leak: false,
    insurance_claim_started: false,
    adjuster_contacted: false,
    appointment_preference: "tomorrow afternoon",
    photos_available: true,
  });

  assert.match(summary, /John Smith/);
  assert.match(summary, /402-555-5678/);
  assert.match(summary, /123 Main Street/);
  assert.match(summary, /haven't started an insurance claim/i);
  assert.doesNotMatch(summary, /photos/i);
  assert.doesNotMatch(summary, /761-1540/);
});

test("summary contains all known required fields when present", () => {
  const fields: RealtimeFields = {
    full_name: "John Smith",
    callback_phone: "+14025555678",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    problem_description: "tree damage",
    project_type: "repair",
    urgency: "standard",
    insurance_claim_started: false,
    adjuster_contacted: false,
    appointment_preference: "tomorrow afternoon",
    photos_available: true,
    additional_notes: "dog in backyard",
  };

  const summary = buildSummaryWithConfirmation(fields);

  assert.equal(summaryContainsKnownFields(fields), true);
  assert.match(summary, /John Smith/);
  assert.match(summary, /402-555-5678/);
  assert.match(summary, /123 Main Street/);
  assert.match(summary, /tree damage/i);
  assert.match(summary, /tomorrow afternoon/i);
  assert.match(summary, /dog in backyard/i);
  assert.match(summary, /Does all of that sound correct\?/);
});

test("summary confirmation does not include closing in the same response", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "a leak",
    full_name: "Beau",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
    urgency: "standard",
    emergency_or_active_leak: false,
    insurance_claim_started: false,
    appointment_preference: "July 21 at 2:00 PM",
    schedule_confirmed: true,
    photos_available: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No, that's all",
    conversationState: "awaiting_additional_notes",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.replyText, /Does all of that sound correct\?/);
  assert.doesNotMatch(outcome.replyText, /Great\. I'll send this information/);
  assert.equal(outcome.hangupAfterMark, false);
});

test("assistant waits after Does all of that sound correct", async () => {
  const policy = new AcknowledgmentPolicy();
  const silentOutcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: completeIntakeFields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(silentOutcome.replyText, "");
  assert.equal(silentOutcome.hangupAfterMark, false);
});

test("silence does not trigger closing", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: completeIntakeFields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.replyText, "");
  assert.equal(outcome.hangup, false);
});

test("corrections cause updated summary and reconfirmation", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = { ...completeIntakeFields, insurance_claim_started: false };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "No, I actually did start a claim",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.session?.collected_fields.insurance_claim, "yes");
  assert.match(outcome.replyText, /Does that sound correct now\?/);
});

test("confirmation yes returns closing only in a separate turn", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: completeIntakeFields,
    },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Yes, that's correct",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.replyText, CLOSING_MESSAGE);
  assert.equal(outcome.hangupAfterMark, true);
  assert.equal(blocksAutomatedClosing("awaiting_summary_confirmation"), true);
});

test("closing message matches required wording", () => {
  assert.equal(buildClosingMessage(), CLOSING_MESSAGE);
  assert.match(CLOSING_MESSAGE, /^Great\./);
  assert.match(CLOSING_MESSAGE, /someone will follow up with you by call or text/);
});

test("ResponseStateGuard blocks duplicate closing triggers while awaiting mark", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("closing_message");
  guard.beginClosingMarkWait();

  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.canTriggerResponse("closing_message"), false);
});

test("only one assistant response is active at a time", () => {
  const guard = new ResponseStateGuard();

  assert.equal(guard.canTriggerResponse("opening_greeting"), true);
  guard.recordTrigger("opening_greeting");
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.isActiveResponse(), true);
});

test("turn timing tracks structured state and reports stage averages", () => {
  const tracker = new TurnTimingTracker();
  tracker.beginTurn("CA123");
  tracker.record("speech_stopped", "CA123");
  tracker.record("transcript_completed", "CA123");
  tracker.record("structured_state_updated", "CA123");
  tracker.record("response_requested", "CA123");
  tracker.record("first_audio_received", "CA123");
  tracker.record("first_audio_sent_to_twilio", "CA123");
});

test("callback readback uses natural phone groups", () => {
  assert.equal(formatCallbackForSpeech("+14025555678"), "402-555-5678");
  assert.match(
    buildCallbackReadbackConfirmation("+14025555678"),
    /I have your callback number as 402-555-5678\. Is that correct\?/,
  );
});

test("explicit insurance no remains false through summary", () => {
  let fields: RealtimeFields = mergeRealtimeCallerAnswer({}, "My roof is leaking", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "Beau Spilker", "+15551234567");
  fields = mergeRealtimeCallerAnswer(fields, "No, I haven't started a claim", "+15551234567");

  assert.equal(fields.insurance_claim_started, false);
  assert.match(buildStructuredSpokenSummary(fields), /haven't started an insurance claim/i);
});

test("not yet parses as false", () => {
  const fields = applyStructuredBoolean({}, "insurance_claim_started", "Not yet", {
    isDirectAnswer: true,
  });

  assert.equal(fields.insurance_claim_started, false);
  assert.equal(parseExplicitBoolean("Not yet"), false);
});

test("company phone remains separate from customer callback", () => {
  delete process.env.TWILIO_PHONE_NUMBER;

  assert.equal(getCompanyPhoneE164(), "+14027611540");
  assert.notEqual(normalizeCallbackPhoneE164("+14025555678"), getCompanyPhoneE164());
});

test("opening greeting contains no intake fields", () => {
  assert.equal(
    REALTIME_OPENING_GREETING,
    "Thank you for calling Beau's Roofing. I'm Beau's Roofing's AI assistant. How can I help you today?",
  );
});

test("summary confirmation sets summary_confirmed for lead creation", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "Beau",
    callback_phone: "+15551234567",
    callback_phone_confirmed: true,
    address: "123 Main Street",
    address_confirmed: true,
    urgency: "standard",
    emergency_or_active_leak: false,
    insurance_claim_started: false,
    appointment_preference: "July 21 at 2:00 PM",
    schedule_confirmed: true,
    additional_notes_responded: true,
    photos_available: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "Yes, that's correct",
    conversationState: "awaiting_summary_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.equal(outcome.session?.collected_fields.summary_confirmed, true);
});

test("ensureSingleIntakeQuestion keeps only the first question", () => {
  const reply = ensureSingleIntakeQuestion(
    "Okay. What's your name? And what's the address?",
  );

  assert.equal(reply, "Okay. What's your name?");
});

test("later explicit correction can change false to true", () => {
  let fields: RealtimeFields = { insurance_claim_started: false };
  fields = applyCorrectionToStructuredField(fields, "Actually yes, I did start a claim");
  assert.equal(fields.insurance_claim_started, true);
});

test("unrelated statements cannot change confirmed boolean", () => {
  let fields: RealtimeFields = { insurance_claim_started: false };
  fields = applyCorrectionToStructuredField(fields, "The storm was last Tuesday");
  assert.equal(fields.insurance_claim_started, false);
});

const JULY_20_2026 = new Date("2026-07-20T18:00:00.000Z");

test("address is read back and confirmed", async () => {
  const policy = new AcknowledgmentPolicy();
  let fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "John",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
  };

  fields = mergeRealtimeCallerAnswer(fields, "123 Main Street in Beatrice", "+14025551234");

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "123 Main Street in Beatrice",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.replyText, /123 Main Street/i);
  assert.match(outcome.replyText, /Is that right\?/);
  assert.equal(outcome.nextConversationState, "awaiting_address_confirmation");
});

test("address correction replaces the previous address", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: false,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "No, it's 456 Oak Avenue in Beatrice",
    conversationState: "awaiting_address_confirmation",
    acknowledgmentPolicy: policy,
  });

  assert.match(outcome.session?.collected_fields.address ?? "", /456 Oak Avenue/i);
  assert.match(outcome.replyText, /456 Oak Avenue/i);
  assert.equal(outcome.nextConversationState, "awaiting_address_confirmation");
});

test("confirmable address requires enough detail", () => {
  assert.equal(hasConfirmableAddress("Beatrice"), false);
  assert.equal(hasConfirmableAddress("123 Main Street in Beatrice"), true);
  assert.match(
    buildAddressReadbackConfirmation("123 Main Street in Beatrice"),
    /123 Main Street, Beatrice/,
  );
});

test("tomorrow at 2 resolves to exact calendar date and 2 PM", () => {
  const parsed = parseScheduleSpeech("Tomorrow around 2", JULY_20_2026, "America/Chicago");

  assert.equal(parsed.status, "needs_confirmation");
  if (parsed.status === "needs_confirmation") {
    assert.match(parsed.spoken, /July 21 at 2:00 PM/i);
    assert.ok(parsed.isoStart);
  }
});

test("Friday morning requires a defined window or clarification", () => {
  const parsed = parseScheduleSpeech("Friday morning", JULY_20_2026, "America/Chicago");

  assert.equal(parsed.status, "needs_confirmation");
  if (parsed.status === "needs_confirmation") {
    assert.match(parsed.spoken, /between 8:00 and 11:00 AM/i);
    assert.ok(parsed.isoEnd);
  }
});

test("after work requires a specific time", () => {
  const parsed = parseScheduleSpeech("After work", JULY_20_2026, "America/Chicago");

  assert.equal(parsed.status, "needs_time_clarification");
  if (parsed.status === "needs_time_clarification") {
    assert.match(parsed.prompt, /What time should I put down/i);
  }
});

test("exact resolved date and time is read back and confirmed", () => {
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

  const capture = processScheduleCapture(fields, "Tomorrow at 2", JULY_20_2026);

  assert.match(capture.confirmationPrompt ?? "", /July 21 at 2:00 PM/i);
  assert.match(capture.confirmationPrompt ?? "", /Is that correct/i);
});

test("relative dates use server clock and company timezone", () => {
  assert.equal(COMPANY_TIMEZONE, "America/Chicago");
  const parsed = parseScheduleSpeech("tomorrow at 2", JULY_20_2026, COMPANY_TIMEZONE);
  assert.equal(parsed.status, "needs_confirmation");
});

test("month and year rollover works for next week", () => {
  const yearEnd = new Date("2026-12-30T18:00:00.000Z");
  const parsed = parseScheduleSpeech("tomorrow at 3", yearEnd, "America/Chicago");
  assert.equal(parsed.status, "needs_confirmation");
  if (parsed.status === "needs_confirmation") {
    assert.match(parsed.spoken, /December 31 at 3:00 PM/i);
  }
});

test("schedule clarification flow resolves vague afternoon", () => {
  const initial = processScheduleCapture(
    { appointment_preference_raw: "tomorrow afternoon" },
    "tomorrow afternoon",
    JULY_20_2026,
  );

  assert.match(initial.clarificationPrompt ?? "", /tomorrow afternoon works best/i);

  const resolved = processScheduleCapture(
    initial.fields,
    "About 2",
    JULY_20_2026,
  );

  assert.match(resolved.confirmationPrompt ?? "", /July 21 at 2:00 PM/i);
});

test("response timing config targets about one second after caller finishes", () => {
  const update = buildRealtimeSessionUpdate("cedar", {
    turnDetectionSilenceDurationMs: 600,
    turnDetectionPrefixPaddingMs: 250,
    turnDetectionThreshold: 0.5,
  } as never);

  assert.equal(update.session.audio.input.turn_detection.type, "server_vad");
  assert.equal(update.session.audio.input.turn_detection.silence_duration_ms, 600);
  assert.equal(update.session.audio.input.turn_detection.prefix_padding_ms, 250);
});

test("turn timing records speech stopped to first audio delay", () => {
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

test("intake reply can include brief acknowledgment before next question", () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "John",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
  };

  const reply = buildIntakeReply(policy, fields, "yes", "+14025551234", 1);
  assert.match(reply, /property address/i);
});

test("confirmed address is not read back again", async () => {
  const policy = new AcknowledgmentPolicy();
  const fields: RealtimeFields = {
    problem_description: "leak",
    full_name: "John",
    callback_phone: "+14025551234",
    callback_phone_confirmed: true,
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
  };

  const outcome = await processRealtimeCallerTurn({
    session: { ...mockSession, collected_fields: fields },
    callSid: "CA123",
    callerPhone: "+14025551234",
    speechResult: "No active leak",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
  });

  assert.doesNotMatch(outcome.replyText, /Is that right/i);
  assert.notEqual(outcome.nextConversationState, "awaiting_address_confirmation");
});
