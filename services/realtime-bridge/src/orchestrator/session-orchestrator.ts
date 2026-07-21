import {
  createTranscriptEntry,
  ensureCallSessionForTwilioCall,
  getCallSessionBySid,
  type CallSession,
  updateCallSession,
} from "../../../../lib/call-sessions.js";
import { logError, logInfo } from "../logger.js";
import type { ConversationState } from "./conversation-state.js";
import { AcknowledgmentPolicy } from "./acknowledgment-policy.js";
import { processRealtimeCallerTurn } from "./realtime-turn-processor.js";
import {
  ensureSingleIntakeQuestion,
  REALTIME_OPENING_GREETING,
  REALTIME_OPENING_QUESTION,
} from "./realtime-prompts.js";

export type OrchestratorContext = {
  callSid: string;
  callerPhone: string;
  calledPhone: string;
};

export type OrchestratorReply = {
  replyText: string;
  hangup: boolean;
  hangupAfterMark: boolean;
  structuredStateUpdated?: boolean;
};

export class SessionOrchestrator {
  private session: CallSession | null = null;
  private processingTurn = false;
  private pendingTranscript: string | null = null;
  private conversationState: ConversationState = "collecting_intake";
  private awaitingFirstCallerTurn = false;
  private readonly acknowledgmentPolicy = new AcknowledgmentPolicy();

  constructor(private readonly context: OrchestratorContext) {}

  async initialize(): Promise<string> {
    try {
      this.session = await ensureCallSessionForTwilioCall({
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        calledPhone: this.context.calledPhone,
      });

      if (this.session) {
        await updateCallSession({
          callSid: this.context.callSid,
          currentQuestion: REALTIME_OPENING_QUESTION,
          transcriptEntry: createTranscriptEntry("assistant", REALTIME_OPENING_GREETING),
        });
      }
    } catch (error) {
      logError("session_initialize_failed", { callSid: this.context.callSid }, error);
    }

    logInfo("session_initialized", {
      callSid: this.context.callSid,
      hasSession: Boolean(this.session),
    });

    return REALTIME_OPENING_GREETING;
  }

  getOpeningGreeting(): string {
    return REALTIME_OPENING_GREETING;
  }

  getConversationState(): ConversationState {
    return this.conversationState;
  }

  onAssistantResponseDone(): void {
    if (this.conversationState === "presenting_summary") {
      this.conversationState = "awaiting_summary_confirmation";
      logInfo("conversation_state_transition", {
        callSid: this.context.callSid,
        state: this.conversationState,
      });
    }

    if (this.conversationState === "delivering_closing") {
      this.conversationState = "closing_audio_playback";
      logInfo("conversation_state_transition", {
        callSid: this.context.callSid,
        state: this.conversationState,
      });
    }
  }

  onClosingMarkPlayed(): void {
    this.conversationState = "completed";
    logInfo("conversation_state_transition", {
      callSid: this.context.callSid,
      state: this.conversationState,
    });
  }

  hasPendingTranscript(): boolean {
    return Boolean(this.pendingTranscript);
  }

  consumePendingTranscript(): string | null {
    const pending = this.pendingTranscript;
    this.pendingTranscript = null;
    return pending;
  }

  markOpeningDelivered(): void {
    this.awaitingFirstCallerTurn = true;
  }

  async handleCallerTranscript(transcript: string, turnId?: number): Promise<OrchestratorReply | null> {
    const trimmed = transcript.trim();

    if (!trimmed) {
      return null;
    }

    if (this.processingTurn) {
      this.pendingTranscript = trimmed;
      logInfo("caller_transcript_queued", {
        callSid: this.context.callSid,
        queueLength: 1,
      });
      return null;
    }

    this.processingTurn = true;

    try {
      if (!this.session) {
        this.session = await getCallSessionBySid(this.context.callSid);
      }

      const outcome = await processRealtimeCallerTurn({
        session: this.session,
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        speechResult: trimmed,
        conversationState: this.conversationState,
        acknowledgmentPolicy: this.acknowledgmentPolicy,
        isFirstCallerTurn: this.awaitingFirstCallerTurn,
        turnId,
      });

      this.session = outcome.session;
      this.conversationState = outcome.nextConversationState;
      this.awaitingFirstCallerTurn = false;

      if (!outcome.replyText) {
        return null;
      }

      return {
        replyText: ensureSingleIntakeQuestion(outcome.replyText),
        hangup: outcome.hangup,
        hangupAfterMark: outcome.hangupAfterMark,
        structuredStateUpdated: outcome.structuredStateUpdated,
      };
    } catch (error) {
      logError("turn_processing_failed", { callSid: this.context.callSid }, error);
      return {
        replyText: "Sorry, I missed that — could you say it again?",
        hangup: false,
        hangupAfterMark: false,
      };
    } finally {
      this.processingTurn = false;
    }
  }

  getSession(): CallSession | null {
    return this.session;
  }
}
