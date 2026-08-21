import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAllFieldsFromTranscript,
  mergeExtractedFields,
} from "../src/orchestrator/multi-field-extraction.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";

const CALLER_PHONE = "+15551234567";

test("roof age alone populates additional_notes", () => {
  const extracted = extractAllFieldsFromTranscript(
    "The roof is about 20 years old.",
    CALLER_PHONE,
  );

  assert.equal(extracted.additional_notes, "Roof is approximately 20 years old.");
});

test("roof age appends to existing additional_notes from the same utterance", () => {
  const speech =
    "I'm at 412 Lakeview Drive, the roof is about 20 years old, and I haven't contacted insurance because I wasn't sure if the damage was bad enough.";

  const extracted = extractAllFieldsFromTranscript(speech, CALLER_PHONE);

  assert.match(extracted.additional_notes ?? "", /wasn't sure if the damage was bad enough/i);
  assert.match(extracted.additional_notes ?? "", /Roof is approximately 20 years old\.$/);
});

test("roof age is not duplicated when the formatted note is already present", () => {
  const extracted = extractAllFieldsFromTranscript(
    "The roof is about 20 years old.",
    CALLER_PHONE,
  );

  assert.equal(extracted.additional_notes, "Roof is approximately 20 years old.");

  const merged = mergeExtractedFields(
    { additional_notes: "Roof is approximately 20 years old." },
    extracted,
  );

  assert.equal(merged.additional_notes, "Roof is approximately 20 years old.");
});

test("roof age merge preserves prior notes on accumulated fields", () => {
  const speech =
    "Insurance hasn't come out yet and the roof is probably 20 years old.";

  const extracted = extractAllFieldsFromTranscript(speech, CALLER_PHONE);
  const merged = mergeExtractedFields({}, extracted, speech);

  assert.match(merged.additional_notes ?? "", /Insurance hasn't come out yet/i);
  assert.match(merged.additional_notes ?? "", /Roof is approximately 20 years old/i);
});

test("existing multi-field extraction without roof age remains intact", () => {
  const speech =
    "I'm John Smith, the address is 123 Main Street, and a tree hit the roof yesterday.";

  const extracted = extractAllFieldsFromTranscript(speech, CALLER_PHONE);
  const merged = mergeExtractedFields({}, extracted);

  assert.equal(merged.full_name, "John Smith");
  assert.match(merged.address ?? "", /123 Main Street/i);
  assert.match(merged.problem_description ?? "", /tree hit the roof/i);
  assert.equal(merged.additional_notes, undefined);
});

test("Sarah Miller multi-field example keeps roof age with other captured fields", () => {
  const speech =
    "I'm Sarah Miller, I'm at 412 Lakeview Drive, and the roof is probably 20 years old. We lost some shingles last night.";

  const fields = mergeRealtimeCallerAnswer({}, speech, CALLER_PHONE);

  assert.equal(fields.full_name, "Sarah Miller");
  assert.match(fields.address ?? "", /412 Lakeview Drive/i);
  assert.match(fields.problem_description ?? "", /shingles/i);
  assert.equal(fields.additional_notes, "Roof is approximately 20 years old.");
});
