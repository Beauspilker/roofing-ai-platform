import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveLastContactedAtUpdate,
  shouldSetLastContactedAt,
} from "./leads.js";

const EXISTING_CONTACT = "2026-01-15T14:30:00.000Z";
const FIXED_NOW = new Date("2026-07-13T16:00:00.000Z");

test("New → Contacted sets last_contacted_at when null", () => {
  assert.equal(shouldSetLastContactedAt("new", "contacted", null), true);
  assert.equal(
    resolveLastContactedAtUpdate("new", "contacted", null, FIXED_NOW),
    FIXED_NOW.toISOString(),
  );
});

test("existing last_contacted_at is preserved on transition to Contacted", () => {
  assert.equal(
    shouldSetLastContactedAt("new", "contacted", EXISTING_CONTACT),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate(
      "new",
      "contacted",
      EXISTING_CONTACT,
      FIXED_NOW,
    ),
    undefined,
  );
});

test("saving Contacted again does not overwrite last_contacted_at", () => {
  assert.equal(
    shouldSetLastContactedAt("contacted", "contacted", EXISTING_CONTACT),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate(
      "contacted",
      "contacted",
      EXISTING_CONTACT,
      FIXED_NOW,
    ),
    undefined,
  );
});

test("non-Contacted status transitions do not set last_contacted_at", () => {
  assert.equal(
    shouldSetLastContactedAt("new", "appointment_scheduled", null),
    false,
  );
  assert.equal(
    resolveLastContactedAtUpdate(
      "contacted",
      "appointment_scheduled",
      null,
      FIXED_NOW,
    ),
    undefined,
  );
  assert.equal(
    resolveLastContactedAtUpdate("new", "lost", null, FIXED_NOW),
    undefined,
  );
});

test("lost → Contacted sets last_contacted_at when null", () => {
  assert.equal(shouldSetLastContactedAt("lost", "contacted", null), true);
  assert.equal(
    resolveLastContactedAtUpdate("lost", "contacted", null, FIXED_NOW),
    FIXED_NOW.toISOString(),
  );
});

test("Contacted with null timestamp is not set without a status transition", () => {
  assert.equal(shouldSetLastContactedAt("contacted", "contacted", null), false);
  assert.equal(
    resolveLastContactedAtUpdate("contacted", "contacted", null, FIXED_NOW),
    undefined,
  );
});
