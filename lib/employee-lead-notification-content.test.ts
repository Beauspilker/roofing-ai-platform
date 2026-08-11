import assert from "node:assert/strict";
import test from "node:test";

import type { Company } from "./companies.js";
import type { Lead } from "./leads.js";
import {
  buildEmployeeLeadNotificationContent,
  pickEmailRecipient,
  pickSmsRecipient,
  resolveEmployeeNotificationRecipients,
  type EmployeeNotificationRecipients,
} from "./employee-lead-notification-content.js";

const sampleCompany = (overrides: Partial<Company> = {}): Company => ({
  id: "company-a",
  user_id: "user-1",
  company_name: "Acme Roofing",
  owner_name: "Owner",
  business_phone: "(402) 555-0100",
  business_email: "owner@acmeroofing.test",
  website: null,
  address_line_1: null,
  city: null,
  state: null,
  postal_code: null,
  service_area: null,
  years_in_business: null,
  created_at: "2026-07-13T18:00:00.000Z",
  updated_at: "2026-07-13T18:00:00.000Z",
  ...overrides,
});

const sampleLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: "lead-1",
  company_id: "company-a",
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
  insurance_claim: false,
  appointment_at: null,
  estimate_amount: null,
  estimate_sent_at: null,
  last_contacted_at: null,
  archived_at: null,
  created_at: "2026-07-13T18:00:00.000Z",
  updated_at: "2026-07-13T18:00:00.000Z",
  ...overrides,
});

const recipients = (
  overrides: Partial<EmployeeNotificationRecipients> = {},
): EmployeeNotificationRecipients => ({
  smsRecipient: "(402) 555-0100",
  emailRecipient: "alerts@acmeroofing.test",
  emergencySmsRecipient: "(402) 555-0100",
  emergencyEmailRecipient: "alerts@acmeroofing.test",
  smsEnabled: true,
  emailEnabled: false,
  ...overrides,
});

test("pickSmsRecipient returns null when SMS notifications are disabled", () => {
  assert.equal(
    pickSmsRecipient(recipients({ smsEnabled: false }), "normal"),
    null,
  );
});

test("pickSmsRecipient normalizes business phone to E.164 for Twilio", () => {
  assert.equal(
    pickSmsRecipient(recipients({ smsRecipient: "(402) 555-0100" }), "normal"),
    "+14025550100",
  );
});

test("pickSmsRecipient uses urgent emergency recipient when configured", () => {
  assert.equal(
    pickSmsRecipient(
      recipients({
        smsRecipient: "(402) 555-0100",
        emergencySmsRecipient: "(402) 555-0199",
      }),
      "urgent",
    ),
    "+14025550199",
  );
});

test("pickEmailRecipient returns null when email notifications are disabled", () => {
  assert.equal(
    pickEmailRecipient(recipients({ emailEnabled: false }), "normal"),
    null,
  );
});

test("buildEmployeeLeadNotificationContent preserves existing SMS formatting", () => {
  const content = buildEmployeeLeadNotificationContent({
    lead: sampleLead(),
    fields: {
      problem_description: "Routine inspection request",
      summary_confirmed: true,
    },
    callSid: "CA1234567890",
    conversationId: "session-1",
    dashboardUrl: "https://app.example.com/dashboard/leads/lead-1",
  });

  assert.match(content.smsBody, /^New Phone AI Lead/);
  assert.match(content.smsBody, /Jane Smith/);
  assert.match(content.smsBody, /Routine inspection request/);
  assert.match(content.smsBody, /View lead: https:\/\/app\.example\.com/);
});

test("resolveEmployeeNotificationRecipients uses company business phone", async () => {
  const company = sampleCompany({ business_phone: "(402) 555-7777" });

  const resolved = await resolveEmployeeNotificationRecipients(company);

  assert.equal(resolved.smsRecipient, "(402) 555-7777");
  assert.equal(resolved.emailRecipient, "owner@acmeroofing.test");
});
