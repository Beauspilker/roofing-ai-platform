import { markFieldCaptured } from "./field-completion.js";
import type { RealtimeFields } from "./realtime-prompts.js";
import { isStructuredBooleanUnset, syncLegacyStringFields } from "./structured-intake.js";

export const LEAK_SIGNAL_PATTERN =
  /\b(water is leaking|water'?s leaking|is leaking|roof leak|there is a leak|there'?s a leak|active leak|water is coming through|water is coming into|water is getting in|water is pouring|leaking into|leaking inside|ceiling is dripping|water intrusion|moisture is coming in|leaks when it rains|water coming through the ceiling|water getting inside)\b/i;

export function problemDescriptionImpliesActiveLeak(problem: string | undefined): boolean {
  if (!problem?.trim()) {
    return false;
  }

  return LEAK_SIGNAL_PATTERN.test(problem);
}

export function inferFieldsFromCapturedContext(fields: RealtimeFields): RealtimeFields {
  let updated: RealtimeFields = { ...fields };

  if (
    isStructuredBooleanUnset(updated.emergency_or_active_leak) &&
    problemDescriptionImpliesActiveLeak(updated.problem_description)
  ) {
    updated = syncLegacyStringFields({
      ...updated,
      emergency_or_active_leak: true,
      emergency_acknowledged: updated.emergency_acknowledged ?? true,
    });
    updated = markFieldCaptured(updated, "emergency_or_active_leak");
  }

  return updated;
}
