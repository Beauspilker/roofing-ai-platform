const ALLOWED_ACKNOWLEDGMENTS = [
  "Got it.",
  "Okay.",
  "Understood.",
  "Thanks for clarifying.",
  "That helps.",
  "All right.",
  "I've noted that.",
  "Thanks.",
] as const;

export const CLOSING_PHRASES = [
  "sounds good",
  "perfect, we're all set",
  "perfect we're all set",
  "that should be everything",
  "we'll get that taken care of",
  "someone will contact you soon",
  "thanks for calling",
  "have a great day",
  "we're all set",
  "all set",
] as const;

export class AcknowledgmentPolicy {
  private lastAcknowledgment: string | null = null;
  private gotItCount = 0;
  private selectionIndex = 0;

  selectAcknowledgment(options: {
    isEmergency?: boolean;
    emergencyAlreadyAcknowledged?: boolean;
    fieldsFilledCount?: number;
    nextStage?: string;
  }): string | null {
    if (options.isEmergency && !options.emergencyAlreadyAcknowledged) {
      const ack = "I'll flag this as urgent.";
      this.recordUsed(ack);
      return ack;
    }

    if ((options.fieldsFilledCount ?? 0) >= 2) {
      this.recordUsed(null);
      return null;
    }

    const candidates = ALLOWED_ACKNOWLEDGMENTS.filter((ack) => {
      if (ack === this.lastAcknowledgment) {
        return false;
      }

      if (ack === "Got it." && this.gotItCount >= 2) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      this.recordUsed(null);
      return null;
    }

    const index = this.selectionIndex % candidates.length;
    this.selectionIndex += 1;
    const selected = candidates[index] ?? null;
    this.recordUsed(selected);
    return selected;
  }

  recordUsed(acknowledgment: string | null): void {
    this.lastAcknowledgment = acknowledgment;

    if (acknowledgment === "Got it.") {
      this.gotItCount += 1;
    }
  }

  getLastAcknowledgment(): string | null {
    return this.lastAcknowledgment;
  }

  getGotItCount(): number {
    return this.gotItCount;
  }
}

export function containsClosingPhrase(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return CLOSING_PHRASES.some(
    (phrase) => normalized.includes(phrase) || normalized === phrase,
  );
}

export function sanitizeIntakeReply(text: string): string {
  if (!containsClosingPhrase(text)) {
    return text;
  }

  let sanitized = text;

  for (const phrase of CLOSING_PHRASES) {
    sanitized = sanitized.replace(new RegExp(phrase, "gi"), "").trim();
  }

  return sanitized.replace(/\s+/g, " ").trim();
}
