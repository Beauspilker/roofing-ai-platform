import { problemDescriptionImpliesActiveLeak } from "./field-normalization.js";
import type { RealtimeFields } from "./realtime-prompts.js";

export function extractCallerFirstName(fields: RealtimeFields): string | null {
  const full = fields.full_name?.trim() || fields.caller_first_name?.trim();

  if (!full) {
    return null;
  }

  return full.split(/\s+/)[0] ?? null;
}

function combinedContext(speech: string, fields: RealtimeFields): string {
  return `${speech} ${fields.problem_description ?? ""} ${fields.additional_notes ?? ""}`.toLowerCase();
}

function callerSpeechMentionsActiveWater(speech: string): boolean {
  const lower = speech.toLowerCase();

  return /\b(water (is|'s)? (coming|getting|pouring)|water coming|got (?:a )?(?:little )?water|active leak|leaking (inside|in|through)|wet spot|stain(ing)?|moisture|drip(ping)?|coming through)\b/i.test(
    lower,
  );
}

export function speechMentionsActiveWater(
  speech: string,
  fields: RealtimeFields,
): boolean {
  const lower = combinedContext(speech, fields);

  return (
    fields.emergency_or_active_leak === true ||
    problemDescriptionImpliesActiveLeak(fields.problem_description) ||
    /\b(water (is|'s)? (coming|getting|pouring)|water coming|active leak|leaking (inside|in|through)|wet spot|stain(ing)?|moisture|drip(ping)?|coming through)\b/i.test(
      lower,
    )
  );
}

function speechMentionsStormDamage(speech: string, fields: RealtimeFields): boolean {
  const lower = combinedContext(speech, fields);

  return /\b(storm|hail|wind|shingles? (off|missing|ripped|lost|blown)|tornado|hurricane)\b/i.test(
    lower,
  );
}

function speechMentionsRoofingDetail(speech: string): boolean {
  return /\b(chimney|flashing|skylight|missing shingles|hail damage|wind damage|tree (hit|fell)|tarp)\b/i.test(
    speech,
  );
}

/** Meaningful prefix that responds to what the caller actually said — not generic filler. */
export function buildSituationAwarePrefix(
  before: RealtimeFields,
  after: RealtimeFields,
  speech: string,
): string | null {
  const trimmed = speech.trim();

  if (trimmed.length < 8) {
    return null;
  }

  if (/^(yes|no|yeah|nope|yep|yup|correct|right)\.?$/i.test(trimmed)) {
    return null;
  }

  if (
    callerSpeechMentionsActiveWater(trimmed) &&
    before.emergency_or_active_leak !== true
  ) {
    if (
      /\b(water (is|'s)? (coming|getting|pouring)|water coming|pouring in|ceiling|upstairs|downstairs|getting inside|coming through|got (?:a )?(?:little )?water)\b/i.test(
        trimmed,
      )
    ) {
      return "Yeah, absolutely — if you've already got water coming in, we'll want to get that in front of the team pretty quickly.";
    }

    return "Understood — we'll treat that as urgent and get it in front of the team.";
  }

  if (
    /^hey,? i don'?t know if you (guys )?can help/i.test(trimmed) &&
    !callerSpeechMentionsActiveWater(trimmed)
  ) {
    return "Yeah, absolutely — we can help with that.";
  }

  if (
    /\b(chimney|flashing|skylight)\b/i.test(trimmed) &&
    /\b(wet|leak|water|spot|stain|drip)\b/i.test(trimmed)
  ) {
    return "That could be related to the roof or flashing in that area, so I'll make sure the team knows exactly where you're seeing it.";
  }

  if (
    before.insurance_claim_started === undefined &&
    after.insurance_claim_started === false &&
    /\b(haven't|have not|not yet|didn't|hasn't).*(insurance|adjuster|claim)/i.test(trimmed)
  ) {
    return "That's fine — I'll make sure the roofing team knows that.";
  }

  if (after.adjuster_contacted === true && before.adjuster_contacted !== true) {
    return "I'll note that insurance has already been involved.";
  }

  if (
    !before.problem_description?.trim() &&
    after.problem_description?.trim() &&
    speechMentionsStormDamage(trimmed, after) &&
    !speechMentionsActiveWater(trimmed, after)
  ) {
    return "Yeah, we can definitely help with that storm damage.";
  }

  if (
    !before.problem_description?.trim() &&
    after.problem_description?.trim() &&
    speechMentionsRoofingDetail(trimmed) &&
    !speechMentionsActiveWater(trimmed, after)
  ) {
    return "Yeah, we can definitely help with that.";
  }

  if (
    !before.insurance_claim_started &&
    after.insurance_claim_started === false &&
    /\b(pay(ing)? out of pocket|no insurance|without insurance)\b/i.test(trimmed)
  ) {
    return "No problem — I'll note that for the team.";
  }

  return null;
}

export const STORY_FIRST_TRANSITION_CLAUSE =
  "Let me grab a few details so I can get this over to them.";

export function buildSituationAwareIntakeReply(
  before: RealtimeFields,
  after: RealtimeFields,
  speech: string,
  question: string,
  options: { isFirstStoryTurn?: boolean } = {},
): string {
  const prefix = buildSituationAwarePrefix(before, after, speech);
  const questionTrimmed = question.trim();

  if (!prefix) {
    return questionTrimmed;
  }

  if (options.isFirstStoryTurn) {
    return `${prefix} ${STORY_FIRST_TRANSITION_CLAUSE} ${questionTrimmed}`
      .replace(/\s+/g, " ")
      .trim();
  }

  return `${prefix} ${questionTrimmed}`.replace(/\s+/g, " ").trim();
}
