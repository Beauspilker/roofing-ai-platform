const CONTEXT_ACKNOWLEDGMENTS: Record<string, readonly string[]> = {
  callback_phone: ["Absolutely.", "Thank you."],
  address: ["Thank you.", "All right."],
  emergency_or_active_leak: ["I'm glad everyone is safe.", "Understood."],
  insurance_claim_started: ["That helps.", "Okay."],
  adjuster_contacted: ["That helps.", "Thanks for clarifying."],
  appointment_preference: ["Okay, and", "All right."],
  photos_available: ["Thanks.", "Understood."],
  default: ["Okay.", "Thank you.", "All right.", "That helps."],
} as const;

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
  private turnCount = 0;

  selectAcknowledgment(options: {
    nextField?: string;
    isEmergency?: boolean;
    emergencyAlreadyAcknowledged?: boolean;
    fieldsFilledCount?: number;
    forceAck?: boolean;
  }): string | null {
    this.turnCount += 1;

    if (options.isEmergency && !options.emergencyAlreadyAcknowledged) {
      const ack = "I'm glad everyone is safe.";
      this.recordUsed(ack);
      return ack;
    }

    const shouldAcknowledge =
      options.forceAck === true ||
      this.turnCount % 5 === 1 ||
      this.turnCount % 5 === 3;

    if (!shouldAcknowledge) {
      this.recordUsed(null);
      return null;
    }

    const pool =
      CONTEXT_ACKNOWLEDGMENTS[options.nextField ?? "default"] ??
      CONTEXT_ACKNOWLEDGMENTS.default;
    const candidates = pool.filter((ack) => ack !== this.lastAcknowledgment);

    if (candidates.length === 0) {
      this.recordUsed(null);
      return null;
    }

    const selected = candidates[(this.turnCount + candidates.length) % candidates.length] ?? null;
    this.recordUsed(selected);
    return selected;
  }

  recordUsed(acknowledgment: string | null): void {
    this.lastAcknowledgment = acknowledgment;
  }

  getLastAcknowledgment(): string | null {
    return this.lastAcknowledgment;
  }

  resetTurnCounter(): void {
    this.turnCount = 0;
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

export function joinAcknowledgmentAndQuestion(
  acknowledgment: string | null,
  question: string,
): string {
  if (!acknowledgment) {
    return question;
  }

  const trimmedQuestion = question.trim();

  if (/^(okay, and|all right\.|thank you\.)/i.test(trimmedQuestion)) {
    return `${acknowledgment} ${trimmedQuestion}`.replace(/\s+/g, " ").trim();
  }

  return `${acknowledgment} ${trimmedQuestion}`.replace(/\s+/g, " ").trim();
}
