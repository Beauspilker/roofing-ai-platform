import assert from "node:assert/strict";
import test from "node:test";

import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import {
  buildCallReasonQuestionAfterName,
  hasCompleteCallerName,
  OPENING_CALLER_NAME_QUESTION,
  parseCallerNameParts,
  parseSpelledNameSpeech,
  processCallerNameTurn,
  syncFullNameFromParts,
} from "../src/orchestrator/caller-name-intake.js";
import {
  shouldRequestNameConfirmation,
} from "../../../lib/call-name-capture.js";
import {
  REALTIME_OPENING_GREETING,
  REALTIME_OPENING_NAME_QUESTION,
} from "../src/orchestrator/realtime-prompts.js";
import {
  parseScheduleSpeech,
  processScheduleCapture,
} from "../src/orchestrator/schedule-normalizer.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const JULY_20_2026 = new Date("2026-07-20T18:00:00.000Z");

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

test("opening asks for first and last name first", () => {
  assert.match(REALTIME_OPENING_NAME_QUESTION, /first and last name/i);
  assert.doesNotMatch(REALTIME_OPENING_GREETING, /How can I help you today/i);
});

test("Beau Spilker stores first and last name", () => {
  const parts = parseCallerNameParts("Beau Spilker");
  assert.equal(parts.firstName, "Beau");
  assert.equal(parts.lastName, "Spilker");

  const fields = syncFullNameFromParts({
    caller_first_name: parts.firstName ?? undefined,
    caller_last_name: parts.lastName ?? undefined,
  });
  assert.equal(fields.full_name, "Beau Spilker");
  assert.equal(hasCompleteCallerName(fields), true);
});

test("single first name asks for last name", () => {
  const outcome = processCallerNameTurn({}, "Beau");
  assert.equal(outcome.complete, false);
  assert.match(outcome.replyText ?? "", /last name/i);
  assert.equal(outcome.fields.caller_first_name, "Beau");
  assert.equal(outcome.fields.name_awaiting_last_name, true);
});

test("spelled last name normalizes to Spilker", () => {
  const spelled = parseSpelledNameSpeech("S-P-I-L-K-E-R");
  assert.equal(spelled.lastName, "Spilker");
});

test("spelled full name stores both parts", () => {
  const spelled = parseSpelledNameSpeech("B-E-A-U, S-P-I-L-K-E-R");
  assert.equal(spelled.firstName, "Beau");
  assert.equal(spelled.lastName, "Spilker");
});

test("low-confidence surname triggers spelling clarification", () => {
  const outcome = processCallerNameTurn(
    {
      caller_first_name: "Beau",
      caller_last_name: "Spilker",
      name_needs_clarification: true,
      name_awaiting_last_name_spelling: true,
    },
    "S-P-I-L-K-E-R",
  );
  assert.equal(outcome.fields.caller_last_name, "Spilker");
  assert.equal(outcome.complete, true);
});

test("high-confidence common full name does not repeat confirmation", () => {
  const outcome = processCallerNameTurn({}, "John Smith");
  assert.equal(outcome.complete, true);
  assert.equal(outcome.replyText, null);
  assert.doesNotMatch(outcome.replyText ?? "", /Is that correct/i);
});

test("low speech confidence uncommon name asks for confirmation during opening", () => {
  const outcome = processCallerNameTurn({}, "Beau Spilker", { confidence: 0.5 });
  assert.equal(outcome.complete, false);
  assert.match(outcome.replyText ?? "", /I heard Beau Spilker\. Is that correct/i);
  assert.equal(outcome.fields.name_pending_confirmation, "Beau Spilker");
});

test("high-confidence uncommon name still confirms when surname is unusual", () => {
  assert.equal(
    shouldRequestNameConfirmation({
      parsedName: "Beau Spilker",
      confidence: 0.95,
    }),
    true,
  );
});

test("unclear opening name does not repeat the opening question", () => {
  const outcome = processCallerNameTurn({}, "um");
  assert.equal(outcome.complete, false);
  assert.equal(outcome.replyText, null);
});

test("opening name turn processor does not re-ask before caller responds", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "uh",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.equal(outcome.replyText, "");
  assert.equal(outcome.nextConversationState, "awaiting_opening_name");
});

test("opening name confirmation accepts correction and continues", async () => {
  const confirmOutcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: {
        pending_question: "caller_name",
        name_pending_confirmation: "Bo Spilker",
      },
    },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "No, Beau Spilker",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(confirmOutcome.replyText, /I heard Beau Spilker\. Is that correct/i);

  const acceptedOutcome = await processRealtimeCallerTurn({
    session: confirmOutcome.session,
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Yes",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(
    acceptedOutcome.replyText,
    /What can the roofing team help you with today/i,
  );
  assert.equal(
    (acceptedOutcome.session?.collected_fields as RealtimeFields).full_name,
    "Beau Spilker",
  );
});

test("opening greeting and name question stay separate", () => {
  assert.doesNotMatch(REALTIME_OPENING_GREETING, /\?/);
  assert.match(REALTIME_OPENING_NAME_QUESTION, /first and last name/i);
  assert.notEqual(REALTIME_OPENING_GREETING.trim(), REALTIME_OPENING_NAME_QUESTION.trim());
});

test("unclear opening name reprompts without advancing intake", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "roof damage",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.replyText, /first and last name/i);
  assert.equal(outcome.nextConversationState, "awaiting_opening_name");
});

test("opening name completion asks one reason question", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { pending_question: "caller_name" },
    },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "John Smith",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.replyText, /What can the roofing team help you with today/i);
  assert.equal(outcome.nextConversationState, "listening_for_reason");
  assert.equal(
    (outcome.session?.collected_fields as RealtimeFields).caller_first_name,
    "John",
  );
  assert.equal(
    (outcome.session?.collected_fields as RealtimeFields).caller_last_name,
    "Smith",
  );
});

test("unusual opening name confirms before reason question", async () => {
  const outcome = await processRealtimeCallerTurn({
    session: {
      ...mockSession,
      collected_fields: { pending_question: "caller_name" },
    },
    callSid: "CA123",
    callerPhone: "+14025551948",
    speechResult: "Beau Spilker",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: new AcknowledgmentPolicy(),
  });

  assert.match(outcome.replyText, /I heard Beau Spilker\. Is that correct/i);
  assert.equal(outcome.nextConversationState, "awaiting_opening_name");
});

test("tomorrow afternoon plus 2 o'clock resolves to 2 PM", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "2 o'clock", JULY_20_2026);
  assert.match(resolved.confirmationPrompt ?? "", /2:00 PM/i);
});

test("known afternoon plus at 2 resolves to 2 PM", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "at 2", JULY_20_2026);
  assert.match(resolved.confirmationPrompt ?? "", /2:00 PM/i);
});

test("known morning plus 9 o'clock resolves to 9 AM", () => {
  const resolved = processScheduleCapture(
    {
      appointment_preference_raw: "tomorrow morning",
      schedule_pending_clarification: true,
      schedule_daypart: "morning",
    },
    "9 o'clock",
    JULY_20_2026,
  );
  assert.match(resolved.confirmationPrompt ?? "", /9:00 AM/i);
});

test("known evening plus 7 o'clock resolves to 7 PM", () => {
  const resolved = processScheduleCapture(
    {
      appointment_preference_raw: "tomorrow evening",
      schedule_pending_clarification: true,
      schedule_daypart: "evening",
    },
    "7 o'clock",
    JULY_20_2026,
  );
  assert.match(resolved.confirmationPrompt ?? "", /7:00 PM/i);
});

test("known afternoon plus half past 2 resolves to 2:30 PM", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "half past 2", JULY_20_2026);
  assert.match(resolved.confirmationPrompt ?? "", /2:30 PM/i);
});

test("no daypart plus 2 o'clock asks AM or PM", () => {
  const parsed = parseScheduleSpeech("2 o'clock", JULY_20_2026);
  assert.equal(parsed.status, "needs_time_clarification");
  if (parsed.status === "needs_time_clarification") {
    assert.match(parsed.prompt, /AM or 2:00 PM/i);
  }
});

test("valid 2 o'clock answer does not repeat specific-time question", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "2 o'clock", JULY_20_2026);
  assert.equal(resolved.fields.schedule_pending_clarification, false);
  assert.doesNotMatch(resolved.clarificationPrompt ?? "", /What time/i);
  assert.match(resolved.confirmationPrompt ?? "", /2:00 PM/i);
});

test("2 o'clock confirmation is asked once", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "2 o'clock", JULY_20_2026);
  assert.match(resolved.confirmationPrompt ?? "", /Is that correct/i);
});

test("tomorrow afternoon plus 2 resolves to 2 PM", () => {
  const initial = processScheduleCapture(
    {},
    "Tomorrow afternoon",
    JULY_20_2026,
  );
  assert.match(initial.clarificationPrompt ?? "", /tomorrow afternoon works best/i);

  const resolved = processScheduleCapture(
    initial.fields,
    "2",
    JULY_20_2026,
  );
  assert.match(resolved.confirmationPrompt ?? "", /2:00 PM/i);
});

test("morning daypart resolves 9 to 9 AM", () => {
  const resolved = processScheduleCapture(
    {
      appointment_preference_raw: "tomorrow morning",
      schedule_pending_clarification: true,
      schedule_daypart: "morning",
    },
    "9",
    JULY_20_2026,
  );
  assert.match(resolved.confirmationPrompt ?? "", /9:00 AM/i);
});

test("evening daypart resolves 7:30 to 7:30 PM", () => {
  const resolved = processScheduleCapture(
    {
      appointment_preference_raw: "tomorrow evening",
      schedule_pending_clarification: true,
      schedule_daypart: "evening",
    },
    "7:30",
    JULY_20_2026,
  );
  assert.match(resolved.confirmationPrompt ?? "", /7:30 PM/i);
});

test("bare 2 without daypart asks AM or PM", () => {
  const parsed = parseScheduleSpeech("2", JULY_20_2026);
  assert.equal(parsed.status, "needs_time_clarification");
  if (parsed.status === "needs_time_clarification") {
    assert.match(parsed.prompt, /AM or 2:00 PM/i);
  }
});

test("tomorrow afternoon followed by 2 produces one confirmation", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "2", JULY_20_2026);
  assert.match(resolved.confirmationPrompt ?? "", /Is that correct/i);
  assert.doesNotMatch(resolved.clarificationPrompt ?? "", /What time/i);
});

test("valid short time answer does not repeat specific-time question", () => {
  const initial = processScheduleCapture({}, "Tomorrow afternoon", JULY_20_2026);
  const resolved = processScheduleCapture(initial.fields, "2", JULY_20_2026);
  assert.equal(resolved.fields.schedule_pending_clarification, false);
  assert.match(resolved.confirmationPrompt ?? "", /2:00 PM/i);
});

test("call reason question uses first name after opening name", () => {
  const question = buildCallReasonQuestionAfterName({
    caller_first_name: "Beau",
    caller_last_name: "Spilker",
    full_name: "Beau Spilker",
  });
  assert.match(question, /Thank you, Beau\./i);
  assert.match(question, /What can the roofing team help you with today/i);
});
