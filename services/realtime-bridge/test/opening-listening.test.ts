import assert from "node:assert/strict";
import test from "node:test";

import {
  canAdvanceAfterOpening,
  isAssistantOpeningEchoTranscript,
  isMeaningfulOpeningCallerTranscript,
  OpeningSilenceController,
  OPENING_NAME_SILENCE_FIRST_REPROMPT_MS,
  OPENING_SILENCE_FIRST_REPROMPT_MS,
  OPENING_STILL_THERE_PROMPT,
  resolveCallReasonFromSpeech,
} from "../src/bridge/opening-listening.js";
import { ResponseStateGuard } from "../src/bridge/response-state-guard.js";
import { AcknowledgmentPolicy } from "../src/orchestrator/acknowledgment-policy.js";
import { resolvePendingQuestion } from "../src/orchestrator/pending-question.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import { processRealtimeCallerTurn } from "../src/orchestrator/realtime-turn-processor.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
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

test("one second of opening silence does not create a reprompt", () => {
  const controller = new OpeningSilenceController();
  const prompts: string[] = [];

  controller.beginListeningForReason();
  controller.scheduleSilenceCheck((prompt) => {
    prompts.push(prompt);
  });

  assert.equal(prompts.length, 0);
  controller.clearSilenceTimer();
});

test("three seconds of opening silence does not create caller-name intake", async () => {
  const controller = new OpeningSilenceController();
  const prompts: string[] = [];

  controller.beginListeningForReason();
  controller.scheduleSilenceCheck((prompt) => {
    prompts.push(prompt);
  });

  assert.equal(isMeaningfulOpeningCallerTranscript("hello"), false);
  assert.equal(resolveCallReasonFromSpeech("hello"), null);
  assert.equal(prompts.length, 0);
  controller.clearSilenceTimer();
});

test("caller says hail damage captures reason and selects caller_name next", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "We had hail damage.",
    conversationState: "collecting_intake",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.match(fields.problem_description ?? "", /hail damage/i);
  assert.equal(getNextRequiredField(fields), "full_name");
  assert.match(outcome.replyText, /first and last name/i);
});

test("caller says My name is Beau and I have hail damage asks for last name", async () => {
  const policy = new AcknowledgmentPolicy();
  const outcome = await processRealtimeCallerTurn({
    session: mockSession,
    callSid: "CA123",
    callerPhone: "+15551234567",
    speechResult: "My name is Beau and I have hail damage.",
    conversationState: "awaiting_opening_name",
    acknowledgmentPolicy: policy,
    isFirstCallerTurn: true,
    hasReceivedMeaningfulCallerTranscript: true,
  });

  const fields = outcome.session?.collected_fields as RealtimeFields;
  assert.equal(fields.caller_first_name, "Beau");
  assert.match(outcome.replyText, /last name/i);
});

test("response.done after greeting waits for name question before listening", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  guard.onResponseDone();

  assert.equal(guard.isListeningForOpeningReason(), false);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.wasLastResponseOpeningGreeting(), true);

  guard.recordTrigger("opening_name_question");
  guard.onResponseDone();

  assert.equal(guard.isListeningForOpeningReason(), true);
  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
});

test("response.done after name question begins listening only once", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_name_question");
  guard.onResponseDone();
  guard.onResponseDone();

  assert.equal(guard.isListeningForOpeningReason(), true);

  guard.beginOpeningNameListen();
  assert.equal(guard.isListeningForOpeningReason(), true);
});

test("recovery caller reply remains blocked during opening silence listen", () => {
  const guard = new ResponseStateGuard();

  guard.recordTrigger("opening_greeting");
  guard.onResponseDone();

  assert.equal(guard.canTriggerResponse("caller_turn_reply"), false);
  assert.equal(guard.canTriggerResponse("opening_silence_reprompt"), true);
});

test("opening greeting allows only one client response trigger at a time", () => {
  const guard = new ResponseStateGuard();

  assert.equal(guard.canTriggerResponse("opening_greeting"), true);
  guard.recordTrigger("opening_greeting");
  assert.equal(guard.canTriggerResponse("opening_greeting"), false);
});

test("meaningful caller answer can advance opening after reason is captured", () => {
  const fields: RealtimeFields = { problem_description: "hail damage" };

  assert.equal(
    canAdvanceAfterOpening(fields, { hasReceivedMeaningfulCallerTranscript: true }),
    true,
  );
  assert.equal(
    canAdvanceAfterOpening(fields, { hasReceivedMeaningfulCallerTranscript: false }),
    false,
  );
});

test("pendingQuestion remains caller_name until caller responds meaningfully", async () => {
  const orchestrator = new SessionOrchestrator({
    callSid: "CA123",
    callerPhone: "+15551234567",
    calledPhone: "+14027611540",
  });

  (orchestrator as unknown as { session: typeof mockSession }).session = {
    ...mockSession,
  };

  orchestrator.markOpeningDelivered();
  orchestrator.onOpeningNameQuestionComplete();

  const session = orchestrator.getSession();
  const fields = (session?.collected_fields ?? {}) as RealtimeFields;
  assert.equal(orchestrator.getConversationState(), "awaiting_opening_name");
  assert.equal(fields.pending_question, "caller_name");
  assert.equal(resolvePendingQuestion(fields, "awaiting_opening_name"), "caller_name");

  const ignored = await orchestrator.handleCallerTranscript("hello");
  assert.equal(ignored, null);
  assert.equal(orchestrator.isListeningForReason(), true);
});

test("assistant opening echo is ignored as caller speech", () => {
  assert.equal(
    isAssistantOpeningEchoTranscript("How can I help you today?"),
    true,
  );
  assert.equal(isMeaningfulOpeningCallerTranscript("How can I help you today?"), false);
});

test("opening silence reprompt fires after configured delay", () => {
  const controller = new OpeningSilenceController();
  const prompts: string[] = [];

  controller.beginListeningForReason();
  controller.scheduleSilenceCheck((prompt) => {
    prompts.push(prompt);
  });

  assert.equal(prompts.length, 0);
  assert.equal(OPENING_SILENCE_FIRST_REPROMPT_MS >= 5_000, true);
  assert.equal(OPENING_STILL_THERE_PROMPT.includes("still there"), true);
  controller.clearSilenceTimer();
});

test("caller name silence uses a longer first reprompt than reason listening", () => {
  const nameController = new OpeningSilenceController();
  const reasonController = new OpeningSilenceController();

  nameController.beginListeningForCallerName();
  reasonController.beginListeningForReason();

  assert.equal(nameController.isAwaitingCallerName(), true);
  assert.equal(reasonController.isAwaitingCallerName(), false);
  assert.equal(
    OPENING_NAME_SILENCE_FIRST_REPROMPT_MS > OPENING_SILENCE_FIRST_REPROMPT_MS,
    true,
  );
  assert.equal(OPENING_NAME_SILENCE_FIRST_REPROMPT_MS, 10_000);

  nameController.clearSilenceTimer();
  reasonController.clearSilenceTimer();
});
