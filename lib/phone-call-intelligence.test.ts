import assert from "node:assert/strict";
import test from "node:test";

import type { Lead } from "./leads.js";
import {
  buildPhoneCallIntelligenceFallback,
  buildPhoneCallIntelligenceViewModel,
  extractIntakeHighlights,
  formatCallDuration,
  formatTranscriptRole,
  formatTranscriptTurn,
  parsePhoneLeadDescriptionFallback,
  stripInternalPhoneLeadTags,
} from "./phone-call-intelligence.js";

const sampleLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: "lead-1",
  company_id: "company-1",
  full_name: "Jane Smith",
  phone: "+14025550199",
  email: null,
  address_line_1: "123 Main Street",
  city: "Beatrice",
  state: "NE",
  postal_code: "68310",
  source: "ai_phone",
  status: "new",
  project_type: "storm_damage",
  description: null,
  insurance_claim: true,
  appointment_at: null,
  estimate_amount: null,
  estimate_sent_at: null,
  last_contacted_at: null,
  archived_at: null,
  created_at: "2026-07-13T18:00:00.000Z",
  updated_at: "2026-07-13T18:00:00.000Z",
  ...overrides,
});

test("stripInternalPhoneLeadTags removes internal metadata lines", () => {
  const cleaned = stripInternalPhoneLeadTags(
    [
      "Reason: Hail damage on the roof",
      "Contact: Jane Smith",
      "[Priority: High]",
      "[Source: Phone AI]",
      "[CallSid: CA1234567890]",
      "[ConversationId: session-uuid]",
    ].join("\n"),
  );

  assert.match(cleaned, /Hail damage on the roof/);
  assert.doesNotMatch(cleaned, /CallSid/);
  assert.doesNotMatch(cleaned, /ConversationId/);
});

test("parsePhoneLeadDescriptionFallback extracts summary, priority, and appointment", () => {
  const parsed = parsePhoneLeadDescriptionFallback(
    [
      "Reason: Active roof leak",
      "Contact: Jane Smith",
      "Requested appointment: Tomorrow morning",
      "[Priority: Emergency]",
      "[Source: Phone AI]",
      "[CallSid: CA123]",
    ].join("\n"),
  );

  assert.match(parsed.summary ?? "", /Active roof leak/);
  assert.equal(parsed.priorityLabel, "Emergency");
  assert.equal(parsed.appointmentPreference, "Tomorrow morning");
});

test("formatCallDuration returns readable values", () => {
  assert.equal(
    formatCallDuration("2026-07-13T18:00:00.000Z", "2026-07-13T18:04:30.000Z"),
    "5 min",
  );
  assert.equal(
    formatCallDuration("2026-07-13T18:00:00.000Z", "2026-07-13T18:00:20.000Z"),
    "Less than 1 min",
  );
  assert.equal(formatCallDuration(null, "2026-07-13T18:04:30.000Z"), null);
});

test("formatTranscriptTurn labels caller and assistant turns", () => {
  const turn = formatTranscriptTurn({
    role: "caller",
    content: "I have hail damage on my roof.",
    at: "2026-07-13T18:01:00.000Z",
  });

  assert.equal(formatTranscriptRole("assistant"), "Assistant");
  assert.equal(turn.roleLabel, "Caller");
  assert.equal(turn.content, "I have hail damage on my roof.");
  assert.match(turn.timeLabel ?? "", /2026/);
});

test("extractIntakeHighlights maps collected fields to scan-friendly labels", () => {
  const highlights = extractIntakeHighlights({
    problem_description: "Hail damage on shingles",
    active_leak: "yes",
    insurance_claim: "yes",
    urgency: "urgent",
    appointment_preference: "Tomorrow at 9 AM",
  });

  assert.deepEqual(
    highlights.map((item) => item.label),
    [
      "Reason for call",
      "Active leak",
      "Insurance claim",
      "Urgency",
      "Appointment",
    ],
  );
  assert.equal(highlights[1]?.value, "Yes");
});

test("buildPhoneCallIntelligenceViewModel maps transcript and session enrichment", () => {
  const model = buildPhoneCallIntelligenceViewModel({
    transcriptRow: {
      id: "transcript-1",
      call_session_id: "session-1",
      lead_id: "lead-1",
      company_id: "company-1",
      twilio_call_sid: "CA1234567890",
      transcript: [
        {
          role: "assistant",
          content: "What can the roofing team help you with today?",
          at: "2026-07-13T18:00:10.000Z",
        },
        {
          role: "caller",
          content: "Hail damage on my roof.",
          at: "2026-07-13T18:00:20.000Z",
        },
      ],
      ai_summary: "Reason: Hail damage on shingles\nContact: Jane Smith",
      metadata: {
        priority_label: "High",
        source: "Phone AI",
      },
      created_at: "2026-07-13T18:05:00.000Z",
    },
    session: {
      caller_phone: "+14025550199",
      started_at: "2026-07-13T18:00:00.000Z",
      completed_at: "2026-07-13T18:06:00.000Z",
      collected_fields: {
        problem_description: "Hail damage on shingles",
        active_leak: "no",
        appointment_preference: "Tomorrow at 9 AM",
      },
    },
  });

  assert.equal(model.source, "transcript_record");
  assert.equal(model.isFallback, false);
  assert.equal(model.priorityLabel, "High");
  assert.equal(model.transcript.length, 2);
  assert.equal(model.callDuration, "6 min");
  assert.equal(model.callerPhone, "+14025550199");
  assert.match(model.aiSummary, /Hail damage on shingles/);
  assert.equal(model.highlights.length, 3);
});

test("buildPhoneCallIntelligenceFallback works for ai_phone leads without transcript rows", () => {
  const model = buildPhoneCallIntelligenceFallback(
    sampleLead({
      description: [
        "Reason: Hail damage on the roof",
        "Contact: Jane Smith",
        "Requested appointment: Friday afternoon",
        "[Priority: High]",
        "[Source: Phone AI]",
        "[CallSid: CA123]",
      ].join("\n"),
    }),
  );

  assert.ok(model);
  assert.equal(model?.source, "description_fallback");
  assert.equal(model?.isFallback, true);
  assert.equal(model?.transcript.length, 0);
  assert.equal(model?.priorityLabel, "High");
  assert.match(model?.aiSummary ?? "", /Hail damage on the roof/);
  assert.equal(model?.highlights[0]?.label, "Appointment");
});

test("buildPhoneCallIntelligenceFallback returns null for non-phone leads", () => {
  const model = buildPhoneCallIntelligenceFallback(
    sampleLead({
      source: "manual",
      description: "Manual lead description",
    }),
  );

  assert.equal(model, null);
});
