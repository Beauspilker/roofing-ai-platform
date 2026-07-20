const SPARING_ACKNOWLEDGMENTS = [
  "Okay.",
  "That helps.",
  "All right.",
  "Understood.",
  "Thanks.",
] as const;

export const CLOSING_PHRASES = [
  "sounds good",
  "perfect",
  "perfect, we're all set",
  "perfect we're all set",
  "you're all set",
  "you are all set",
  "that should be everything",
  "that should be it",
  "we have everything we need",
  "we've got everything",
  "we'll get that taken care of",
  "someone will reach out",
  "someone will contact you",
  "someone from the team will reach out",
  "roofing team will reach out",
  "team will reach out",
  "thanks for calling",
  "have a great day",
  "we're all set",
  "all set",
  "follow up with you",
  "send this information",
] as const;

export class AcknowledgmentPolicy {
  private lastAcknowledgment: string | null = null;
  private gotItCount = 0;
  private selectionIndex = 0;
  private turnsSinceAck = 0;

  selectAcknowledgment(options: {
    isEmergency?: boolean;
    emergencyAlreadyAcknowledged?: boolean;
    fieldsFilledCount?: number;
    hasActiveLeak?: boolean;
  }): string | null {
    this.turnsSinceAck += 1;

    if (options.isEmergency && !options.emergencyAlreadyAcknowledged) {
      const ack = "I'll flag this as urgent.";
      this.recordUsed(ack);
      return ack;
    }

    if ((options.fieldsFilledCount ?? 0) >= 3) {
      this.recordUsed(null);
      return null;
    }

    if (this.turnsSinceAck < 2) {
      this.recordUsed(null);
      return null;
    }

    const candidates = SPARING_ACKNOWLEDGMENTS.filter((ack) => ack !== this.lastAcknowledgment);

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
    this.turnsSinceAck = 0;

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

export function guardIntakeReply(reply: string, fallbackQuestion: string): string {
  const sanitized = sanitizeIntakeReply(reply).trim();

  if (!sanitized || sanitized.length < 8) {
    return fallbackQuestion;
  }

  if (containsClosingPhrase(sanitized)) {
    return fallbackQuestion;
  }

  return sanitized;
}
