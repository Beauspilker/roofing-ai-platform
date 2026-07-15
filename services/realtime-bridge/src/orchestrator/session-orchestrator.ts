import { OPENING_GREETING } from "../../../../lib/call-intake.js";
import { processCallerTurn } from "../../../../lib/call-turn-processor.js";
import {
  createTranscriptEntry,
  ensureCallSessionForTwilioCall,
  getCallSessionBySid,
  type CallSession,
  updateCallSession,
} from "../../../../lib/call-sessions.js";
import { OPENING_QUESTION } from "../../../../lib/twilio/helpers.js";
import { logError, logInfo } from "../logger.js";

export type OrchestratorContext = {
  callSid: string;
  callerPhone: string;
  calledPhone: string;
};

export class SessionOrchestrator {
  private session: CallSession | null = null;
  private attempt = 1;
  private isInitial = true;
  private processingTurn = false;
  private pendingTranscript: string | null = null;

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
          currentQuestion: OPENING_QUESTION,
          transcriptEntry: createTranscriptEntry("assistant", OPENING_GREETING),
        });
      }
    } catch (error) {
      logError("session_initialize_failed", { callSid: this.context.callSid }, error);
    }

    logInfo("session_initialized", {
      callSid: this.context.callSid,
      hasSession: Boolean(this.session),
    });

    return OPENING_GREETING;
  }

  async handleCallerTranscript(transcript: string): Promise<{
    replyText: string;
    hangup: boolean;
  } | null> {
    const trimmed = transcript.trim();

    if (!trimmed) {
      return null;
    }

    if (this.processingTurn) {
      this.pendingTranscript = trimmed;
      return null;
    }

    this.processingTurn = true;

    try {
      if (!this.session) {
        this.session = await getCallSessionBySid(this.context.callSid);
      }

      const outcome = await processCallerTurn({
        session: this.session,
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        speechResult: trimmed,
        attempt: this.attempt,
        isInitial: this.isInitial,
      });

      this.session = outcome.session;
      this.isInitial = false;
      this.attempt = 1;

      return {
        replyText: outcome.replyText,
        hangup: outcome.kind === "speak_hangup",
      };
    } catch (error) {
      logError("turn_processing_failed", { callSid: this.context.callSid }, error);
      return {
        replyText:
          "I'm having a little trouble on my end. Could you repeat that for me?",
        hangup: false,
      };
    } finally {
      this.processingTurn = false;

      if (this.pendingTranscript) {
        const pending = this.pendingTranscript;
        this.pendingTranscript = null;
        return this.handleCallerTranscript(pending);
      }
    }
  }

  getSession(): CallSession | null {
    return this.session;
  }
}
