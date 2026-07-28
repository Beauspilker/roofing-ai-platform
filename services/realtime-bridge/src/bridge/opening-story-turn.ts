import { logInfo } from "../logger.js";

/** Extra patience after speech_stopped before treating the opening story as complete. */
export const OPENING_STORY_TURN_DEBOUNCE_MS = 1_400;

export type OpeningStoryTurnReadyHandler = (transcript: string) => void;

export class OpeningStoryTurnController {
  private active = false;
  private callerSpeechActive = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private latestTranscript = "";
  private scheduledTranscript = "";

  beginAwaitingStory(): void {
    this.active = true;
    this.latestTranscript = "";
    this.scheduledTranscript = "";
    this.clearDebounce();
  }

  completeAwaitingStory(): void {
    this.active = false;
    this.callerSpeechActive = false;
    this.latestTranscript = "";
    this.scheduledTranscript = "";
    this.clearDebounce();
  }

  isAwaitingStory(): boolean {
    return this.active;
  }

  isCallerSpeechActive(): boolean {
    return this.callerSpeechActive;
  }

  onCallerSpeechStarted(): void {
    if (!this.active) {
      return;
    }

    this.callerSpeechActive = true;
    this.clearDebounce();
  }

  onCallerSpeechStopped(): void {
    if (!this.active) {
      return;
    }

    this.callerSpeechActive = false;
  }

  noteTranscript(transcript: string, onReady: OpeningStoryTurnReadyHandler): void {
    if (!this.active) {
      onReady(transcript);
      return;
    }

    const trimmed = transcript.trim();
    if (!trimmed) {
      return;
    }

    this.latestTranscript = trimmed;
    this.scheduledTranscript = trimmed;
    this.scheduleReady(onReady);
  }

  private scheduleReady(onReady: OpeningStoryTurnReadyHandler): void {
    this.clearDebounce();

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      if (this.callerSpeechActive) {
        return;
      }

      const transcript = this.scheduledTranscript.trim();
      if (!transcript) {
        return;
      }

      logInfo("opening_story_turn_ready", {
        transcriptLength: transcript.length,
      });

      this.completeAwaitingStory();
      onReady(transcript);
    }, OPENING_STORY_TURN_DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
