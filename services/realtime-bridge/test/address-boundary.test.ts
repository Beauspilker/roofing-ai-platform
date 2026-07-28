import assert from "node:assert/strict";
import test from "node:test";

import {
  containsNonAddressContinuation,
  sanitizeServiceAddress,
  trimAddressAtConversationalBoundary,
} from "../src/orchestrator/address-sanitization.js";
import { extractAddressFromSpeech } from "../src/orchestrator/multi-field-extraction.js";
import { mergeRealtimeCallerAnswer } from "../src/orchestrator/realtime-intake.js";
import { getNextRequiredField } from "../src/orchestrator/required-intake.js";
import type { RealtimeFields } from "../src/orchestrator/realtime-prompts.js";

const CALLER_PHONE = "+15551234567";

test("live failure: storm continuation is trimmed from Beatrice address", () => {
  const speech =
    "My service address is 123 Main Street in Beatrice, Nebraska. Another storm is supposed to come through tomorrow.";

  const address = extractAddressFromSpeech(speech);
  assert.equal(address, "123 Main Street, Beatrice, Nebraska");
  assert.equal(containsNonAddressContinuation(address ?? ""), false);
});

test("live failure: storm context remains available for urgency inference", () => {
  const speech =
    "My service address is 123 Main Street in Beatrice, Nebraska. Another storm is supposed to come through tomorrow.";

  const fields = mergeRealtimeCallerAnswer(
    { full_name: "Jane Doe", problem_description: "roof damage" },
    speech,
    CALLER_PHONE,
  );

  assert.equal(fields.address, "123 Main Street, Beatrice, Nebraska");
  assert.equal(fields.urgency, "high");
});

test("456 Lincoln Avenue stops before need someone out", () => {
  const speech =
    "My address is 456 Lincoln Avenue in Beatrice and I need someone out as soon as possible.";

  assert.equal(extractAddressFromSpeech(speech), "456 Lincoln Avenue, Beatrice");
});

test("789 Lake Drive stops before availability clause", () => {
  const speech =
    "My address is 789 Lake Drive, Beatrice, Nebraska, and I'm available after work around five.";

  assert.equal(
    extractAddressFromSpeech(speech),
    "789 Lake Drive, Beatrice, Nebraska",
  );
});

test("trimming preserves legitimate street and locality information", () => {
  const address = trimAddressAtConversationalBoundary(
    "1200 West A Street, Beatrice, Nebraska",
  );

  assert.equal(address, "1200 West A Street, Beatrice, Nebraska");
});

test("sanitizeServiceAddress rejects obvious non-address clauses", () => {
  assert.equal(
    sanitizeServiceAddress("123 Main Street storm is supposed to come through tomorrow"),
    null,
  );
  assert.equal(
    sanitizeServiceAddress("456 Oak Avenue need someone out as soon as possible"),
    null,
  );
});

test("confirmed sanitized address cannot be overwritten by later contaminated candidate", () => {
  const confirmed: RealtimeFields = {
    full_name: "Jane Doe",
    problem_description: "roof leak",
    address: "123 Main Street, Beatrice, Nebraska",
    address_confirmed: true,
  };

  const fields = mergeRealtimeCallerAnswer(
    confirmed,
    "Another storm is supposed to come through tomorrow and it is urgent.",
    CALLER_PHONE,
  );

  assert.equal(fields.address, "123 Main Street, Beatrice, Nebraska");
  assert.equal(fields.address_confirmed, true);
  assert.notEqual(getNextRequiredField(fields), "address");
});
