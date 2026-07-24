import type { RealtimeFields } from "./realtime-prompts.js";

function formatAckList(items: string[]): string {
  if (items.length === 1) {
    return items[0]!;
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function describeDamage(fields: RealtimeFields): string | null {
  const damage = fields.problem_description?.trim();

  if (!damage) {
    return null;
  }

  if (/\bhail\b/i.test(damage)) {
    return "the hail damage";
  }

  if (/\bleak|water\b/i.test(damage)) {
    if (/kitchen/i.test(damage)) {
      return "the kitchen leak";
    }
    if (/bedroom/i.test(damage)) {
      return "the bedroom leak";
    }
    return "the leak";
  }

  if (/\bstorm\b/i.test(damage)) {
    return "the storm damage";
  }

  return "the roof issue";
}

export function buildContextualMultiFieldAcknowledgment(
  before: RealtimeFields,
  after: RealtimeFields,
  speech: string,
): string | null {
  const trimmed = speech.trim();

  if (trimmed.length < 12) {
    return null;
  }

  if (/^(yes|no|yeah|nope|yep|yup|correct|right)\.?$/i.test(trimmed)) {
    return null;
  }

  const notes: string[] = [];

  if (!before.problem_description?.trim() && after.problem_description?.trim()) {
    const damageNote = describeDamage(after);
    if (damageNote) {
      notes.push(damageNote);
    }
  }

  if (
    before.emergency_or_active_leak !== true &&
    after.emergency_or_active_leak === true
  ) {
    notes.push("the active leak");
  }

  if (
    before.insurance_claim_started === undefined &&
    after.insurance_claim_started === false
  ) {
    notes.push("that insurance hasn't been contacted");
  } else if (
    before.insurance_claim_started === undefined &&
    after.insurance_claim_started === true
  ) {
    notes.push("that insurance is involved");
  }

  if (!before.address?.trim() && after.address?.trim()) {
    notes.push("the service address");
  }

  if (!before.callback_phone?.trim() && after.callback_phone?.trim()) {
    notes.push("your callback number");
  }

  if (
    !before.appointment_preference_raw?.trim() &&
    !before.appointment_preference?.trim() &&
    (after.appointment_preference_raw?.trim() || after.appointment_preference?.trim())
  ) {
    notes.push("your availability");
  }

  if (notes.length < 2) {
    return null;
  }

  return `Thanks. I've noted ${formatAckList(notes.slice(0, 3))}.`;
}
