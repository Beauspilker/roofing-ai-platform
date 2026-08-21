import assert from "node:assert/strict";
import test from "node:test";

import { buildCrmCallSummary } from "./call-summary.js";

test("buildCrmCallSummary produces concise contractor-facing narrative", () => {
  const summary = buildCrmCallSummary({
    problem_description:
      "missing shingles after last night's storm and water staining upstairs near the rear window",
    storm_damage: "yes",
    active_leak: "no",
    insurance_claim: "no",
    appointment_preference: "after 3 PM",
    urgency: "high",
    additional_notes: "Roof is approximately 20 years old.",
  });

  assert.match(summary, /Homeowner reports/i);
  assert.match(summary, /Insurance has not been contacted/i);
  assert.match(summary, /after 3 pm/i);
  assert.doesNotMatch(summary, /^Reason:/m);
  assert.doesNotMatch(summary, /^Contact:/m);
});
