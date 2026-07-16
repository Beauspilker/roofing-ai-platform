import {
  buildNameConfirmationPrompt,
  buildNameRepeatPrompt,
  isAwaitingNameConfirmation,
  processNameCaptureTurn,
} from "../../../../lib/call-name-capture.js";
import { detectEmergency } from "../../../../lib/call-intelligence.js";
import {
  completeCallSession,
  createTranscriptEntry,
  type CallSession,
  updateCallSession,
} from "../../../../lib/call-sessions.js";
import { isGoodbyePhrase } from "../../../../lib/twilio/voice-phrases.js";
import {
  appendAnythingElseNotes,
  buildRealtimeAcknowledgement,
  getRealtimeNextMissingStage,
  getRealtimeStageQuestion,
  isRealtimeIntakeComplete,
  mergeRealtimeCallerAnswer,
  type RealtimeIntakeStage,
  toPersistedFields,
} from "./realtime-intake.js";
import {
  buildRealtimeClosingMessage,
  buildRealtimeIntakeReply,
  isAnythingElseDeclined,
  REALTIME_ANYTHING_ELSE_QUESTION,
  type RealtimeFields,
} from "./realtime-prompts.js";

export type RealtimeTurnOutcome = {
  replyText: string;
  hangup: boolean;
  hangupAfterMark: boolean;
  session: CallSession | null;
};

export type ProcessRealtimeTurnInput = {
  session: CallSession | null;
  callSid: string;
  callerPhone: string;
  speechResult: string;
  endingPhase: "none" | "anything_else";
};

async function persistTurn(
  callSid: string,
  input: {
    collectedFields?: RealtimeFields;
    currentQuestion?: string | null;
    callerSpeech: string;
    assistantReply: string;
  },
): Promise<CallSession | null> {
  const session =
    (await updateCallSession({
      callSid,
      collectedFields: input.collectedFields
        ? toPersistedFields(input.collectedFields)
        : undefined,
      currentQuestion: input.currentQuestion ?? null,
      transcriptEntry: createTranscriptEntry("caller", input.callerSpeech),
    })) ?? null;

  await updateCallSession({
    callSid,
    transcriptEntry: createTranscriptEntry("assistant", input.assistantReply),
  });

  return session;
}

function isNameCaptureTurn(fields: RealtimeFields): boolean {
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }

  return getRealtimeNextMissingStage(fields) === "full_name";
}

export async function processRealtimeCallerTurn(
  input: ProcessRealtimeTurnInput,
): Promise<RealtimeTurnOutcome & { nextEndingPhase: "none" | "anything_else" }> {
  const { callSid, callerPhone, speechResult, endingPhase } = input;
  let session = input.session;

  if (isGoodbyePhrase(speechResult)) {
    if (callSid) {
      await completeCallSession(callSid, "completed");
    }

    return {
      replyText: "Thanks for calling Beau's Roofing — have a great day.",
      hangup: true,
      hangupAfterMark: true,
      session,
      nextEndingPhase: "none",
    };
  }

  if (!session || !callSid) {
    return {
      replyText: "What's going on with the roof?",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextEndingPhase: "none",
    };
  }

  const fieldsBefore = (session.collected_fields ?? {}) as RealtimeFields;

  if (endingPhase === "anything_else") {
    let updatedFields = fieldsBefore;

    if (!isAnythingElseDeclined(speechResult)) {
      updatedFields = appendAnythingElseNotes(fieldsBefore, speechResult);
    }

    const reply = buildRealtimeClosingMessage(updatedFields);

    await completeCallSession(callSid, "completed");
    session =
      (await persistTurn(callSid, {
        collectedFields: updatedFields,
        currentQuestion: null,
        callerSpeech: speechResult,
        assistantReply: reply,
      })) ?? session;

    return {
      replyText: reply,
      hangup: true,
      hangupAfterMark: true,
      session,
      nextEndingPhase: "none",
    };
  }

  if (isNameCaptureTurn(fieldsBefore)) {
    const nameOutcome = processNameCaptureTurn({
      fields: fieldsBefore,
      speech: speechResult,
    });

    if (nameOutcome.status === "confirm" || nameOutcome.status === "repeat") {
      session =
        (await persistTurn(callSid, {
          collectedFields: nameOutcome.fields as RealtimeFields,
          currentQuestion: nameOutcome.replyText,
          callerSpeech: speechResult,
          assistantReply: nameOutcome.replyText,
        })) ?? session;

      return {
        replyText: nameOutcome.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextEndingPhase: "none",
      };
    }

    const confirmedFields = nameOutcome.fields as RealtimeFields;
    const nextStage = getRealtimeNextMissingStage(confirmedFields);

    if (nextStage === "wrap_up") {
      session =
        (await persistTurn(callSid, {
          collectedFields: confirmedFields,
          currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
          callerSpeech: speechResult,
          assistantReply: REALTIME_ANYTHING_ELSE_QUESTION,
        })) ?? session;

      return {
        replyText: REALTIME_ANYTHING_ELSE_QUESTION,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextEndingPhase: "anything_else",
      };
    }

    const reply = buildRealtimeIntakeReply(
      "Thanks.",
      getRealtimeStageQuestion(nextStage, confirmedFields, callerPhone),
    );

    session =
      (await persistTurn(callSid, {
        collectedFields: confirmedFields,
        currentQuestion: getRealtimeStageQuestion(nextStage, confirmedFields, callerPhone),
        callerSpeech: speechResult,
        assistantReply: reply,
      })) ?? session;

    return {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextEndingPhase: "none",
    };
  }

  const answeredStage = getRealtimeNextMissingStage(fieldsBefore);
  let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, speechResult, callerPhone);

  if (detectEmergency(speechResult) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true,
    };
  }

  if (isRealtimeIntakeComplete(updatedFields)) {
    session =
      (await persistTurn(callSid, {
        collectedFields: updatedFields,
        currentQuestion: REALTIME_ANYTHING_ELSE_QUESTION,
        callerSpeech: speechResult,
        assistantReply: REALTIME_ANYTHING_ELSE_QUESTION,
      })) ?? session;

    return {
      replyText: REALTIME_ANYTHING_ELSE_QUESTION,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextEndingPhase: "anything_else",
    };
  }

  const nextStage = getRealtimeNextMissingStage(updatedFields);
  const ack =
    answeredStage !== "wrap_up"
      ? buildRealtimeAcknowledgement(
          answeredStage as RealtimeIntakeStage,
          speechResult,
          updatedFields,
        )
      : null;
  const reply = buildRealtimeIntakeReply(
    ack,
    getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
  );

  session =
    (await persistTurn(callSid, {
      collectedFields: updatedFields,
      currentQuestion: getRealtimeStageQuestion(nextStage, updatedFields, callerPhone),
      callerSpeech: speechResult,
      assistantReply: reply,
    })) ?? session;

  return {
    replyText: reply,
    hangup: false,
    hangupAfterMark: false,
    session,
    nextEndingPhase: "none",
  };
}

export function buildNameNoInputRetry(fields: RealtimeFields): string {
  if (isAwaitingNameConfirmation(fields)) {
    const pending = fields.name_pending_confirmation?.trim();
    if (pending) {
      return `I didn't catch that. ${buildNameConfirmationPrompt(pending)}`;
    }
  }

  if (fields.name_awaiting_repeat) {
    return `I didn't catch that. ${buildNameRepeatPrompt()}`;
  }

  return "I didn't catch that. What's your name?";
}
