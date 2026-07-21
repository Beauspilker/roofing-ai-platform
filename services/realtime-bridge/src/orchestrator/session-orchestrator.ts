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
import { isMeaningfulOpeningCallerTranscript } from "../bridge/opening-listening.js";
import { processRealtimeCallerTurn } from "./realtime-turn-processor.js";
import {
  ensureSingleIntakeQuestion,
  REALTIME_OPENING_GREETING,
  REALTIME_OPENING_QUESTION,
  type RealtimeFields,
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
  private listeningForReason = false;
  private hasReceivedMeaningfulCallerTranscript = false;
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

  onOpeningGreetingComplete(): void {
    this.listeningForReason = true;
    this.attachPendingCallReason();
  }

  isListeningForReason(): boolean {
    return this.listeningForReason && !this.hasReceivedMeaningfulCallerTranscript;
  }

  hasMeaningfulCallerTranscript(): boolean {
    return this.hasReceivedMeaningfulCallerTranscript;
  }

  onMeaningfulCallerTranscriptProcessed(): void {
    this.hasReceivedMeaningfulCallerTranscript = true;
    this.listeningForReason = false;
  }

  private attachPendingCallReason(): void {
    if (!this.session) {
      return;
    }

    const fields = (this.session.collected_fields ?? {}) as RealtimeFields;

    this.session = {
      ...this.session,
      collected_fields: {
        ...fields,
        pending_question: "call_reason",
      },
    };
  }

  async handleCallerTranscript(transcript: string, turnId?: number): Promise<OrchestratorReply | null> {
    const trimmed = transcript.trim();

    if (!trimmed) {
      return null;
    }

    if (this.listeningForReason && !isMeaningfulOpeningCallerTranscript(trimmed)) {
      logInfo("opening_transcript_ignored", {
        callSid: this.context.callSid,
        transcriptLength: trimmed.length,
      });
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
        hasReceivedMeaningfulCallerTranscript:
          this.hasReceivedMeaningfulCallerTranscript ||
          isMeaningfulOpeningCallerTranscript(trimmed),
        turnId,
      });

      if (
        isMeaningfulOpeningCallerTranscript(trimmed) &&
        outcome.session?.collected_fields?.problem_description
      ) {
        this.onMeaningfulCallerTranscriptProcessed();
      }

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
