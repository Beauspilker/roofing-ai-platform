import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Company } from "./companies.js";
import type { CallSession } from "./call-sessions.js";
import type { Lead } from "./leads.js";
import type { Notification } from "./notifications.js";
import { EMPLOYEE_PHONE_AI_LEAD_KIND } from "./employee-lead-notification-content.js";
import {
  __setEmployeeNotificationRuntimeForTests,
  notifyEmployeesOfPhoneAiLead,
} from "./employee-lead-notifications.js";

type MockDb = {
  companies: Map<string, Company>;
  leads: Map<string, Lead>;
  businessSettings: Map<string, Record<string, unknown>>;
  notifications: Notification[];
  activityRows: Record<string, unknown>[];
  callSessionUpdates: Record<string, unknown>[];
};

function sampleCompany(overrides: Partial<Company> = {}): Company {
  return {
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
  };
}

function sampleLead(overrides: Partial<Lead> = {}): Lead {
  return {
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
  };
}

function sampleSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    id: "session-1",
    twilio_call_sid: "CA1234567890",
    company_id: "company-a",
    caller_phone: "+14025550199",
    called_phone: "+14025550000",
    status: "completed",
    current_question: null,
    collected_fields: {
      full_name: "Jane Smith",
      problem_description: "Roof leak",
      summary_confirmed: true,
    },
    transcript: [],
    attempt_count: 1,
    started_at: "2026-07-13T18:00:00.000Z",
    last_activity_at: "2026-07-13T18:05:00.000Z",
    completed_at: "2026-07-13T18:05:00.000Z",
    expires_at: "2026-07-13T19:00:00.000Z",
    created_at: "2026-07-13T18:00:00.000Z",
    updated_at: "2026-07-13T18:05:00.000Z",
    employee_notification_status: null,
    employee_notification_attempts: 0,
    ...overrides,
  };
}

function buildMockSupabase(db: MockDb) {
  const from = (table: string) => {
    const filters: Record<string, string> = {};

    const builder = {
      select(_columns?: string) {
        return builder;
      },
      eq(column: string, value: string) {
        filters[column] = value;
        return builder;
      },
      maybeSingle: async () => {
        if (table === "companies") {
          return { data: db.companies.get(filters.id) ?? null, error: null };
        }

        if (table === "leads") {
          const lead = db.leads.get(filters.id);

          if (lead && lead.company_id === filters.company_id) {
            return { data: lead, error: null };
          }

          return { data: null, error: null };
        }

        if (table === "business_settings") {
          return {
            data: db.businessSettings.get(filters.company_id) ?? null,
            error: null,
          };
        }

        if (table === "notifications") {
          const found = db.notifications.find(
            (row) =>
              row.lead_id === filters.lead_id &&
              row.channel === filters.channel &&
              row.notification_kind === filters.notification_kind,
          );

          return { data: found ?? null, error: null };
        }

        return { data: null, error: null };
      },
      update(payload: Record<string, unknown>) {
        if (table === "notifications") {
          const index = db.notifications.findIndex((row) => row.id === filters.id);

          if (index >= 0) {
            db.notifications[index] = {
              ...db.notifications[index],
              ...payload,
            } as Notification;
          }
        }

        if (table === "call_sessions") {
          db.callSessionUpdates.push(payload);
        }

        return {
          eq: async () => ({ error: null }),
        };
      },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        const rows = Array.isArray(payload) ? payload : [payload];

        if (table === "notifications") {
          const row = rows[0];
          const created = {
            id: `notification-${db.notifications.length + 1}`,
            company_id: row.company_id as string,
            lead_id: row.lead_id as string,
            channel: row.channel as Notification["channel"],
            recipient: row.recipient as string,
            subject: (row.subject as string | null) ?? null,
            message: row.message as string,
            status: row.status as Notification["status"],
            error_message: (row.error_message as string | null) ?? null,
            sent_at: (row.sent_at as string | null) ?? null,
            created_at: "2026-07-13T18:06:00.000Z",
            notification_kind: row.notification_kind as string,
          } satisfies Notification;

          db.notifications.push(created);

          return {
            select: () => ({
              single: async () => ({ data: created, error: null }),
            }),
          };
        }

        if (table === "activity_history") {
          db.activityRows.push(...rows);
          return { error: null };
        }

        return {
          select: () => ({
            single: async () => ({ data: rows[0], error: null }),
          }),
        };
      },
    };

    return builder;
  };

  return { from };
}

function createEnabledSmsDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    companies: new Map([["company-a", sampleCompany()]]),
    leads: new Map([["lead-1", sampleLead()]]),
    businessSettings: new Map([
      [
        "company-a",
        {
          company_id: "company-a",
          sms_follow_up_enabled: true,
          email_follow_up_enabled: false,
          business_hours: {},
        },
      ],
    ]),
    notifications: [],
    activityRows: [],
    callSessionUpdates: [],
    ...overrides,
  };
}

function installRuntime(db: MockDb, sendTwilioSms: ReturnType<typeof mock.fn>) {
  __setEmployeeNotificationRuntimeForTests({
    createClient: () => buildMockSupabase(db),
    sendSms: sendTwilioSms,
  });
}

test.afterEach(() => {
  __setEmployeeNotificationRuntimeForTests(null);
});

test("successful AI phone lead triggers one SMS to configured business phone", async () => {
  const db = createEnabledSmsDb();
  const sendTwilioSms = mock.fn(async () => ({
    delivered: true,
    sid: "SM123",
    simulated: false as const,
  }));

  installRuntime(db, sendTwilioSms);

  const result = await notifyEmployeesOfPhoneAiLead({
    session: sampleSession(),
    leadId: "lead-1",
  });

  assert.equal(result.status, "sent");
  assert.deepEqual(result.status === "sent" ? result.channels : [], ["sms"]);
  assert.equal(sendTwilioSms.mock.callCount(), 1);
  assert.equal(sendTwilioSms.mock.calls[0]?.arguments[0], "+14025550100");
  assert.match(String(sendTwilioSms.mock.calls[0]?.arguments[1]), /Jane Smith/);
  assert.equal(db.notifications.length, 1);
  assert.equal(db.notifications[0]?.status, "sent");
});

test(
  "notification failure does not throw and records failed SMS attempt",
  { timeout: 15_000 },
  async () => {
    const db = createEnabledSmsDb();
    const sendTwilioSms = mock.fn(async () => {
      throw new Error("Twilio SMS failed: unavailable");
    });

    installRuntime(db, sendTwilioSms);

    const result = await notifyEmployeesOfPhoneAiLead({
      session: sampleSession(),
      leadId: "lead-1",
    });

    assert.equal(result.status, "failed");
    assert.match(
      result.status === "failed" ? result.error : "",
      /Twilio SMS failed/,
    );
    assert.equal(sendTwilioSms.mock.callCount(), 3);
    assert.equal(db.notifications.length, 1);
    assert.equal(db.notifications[0]?.status, "failed");
  },
);

test("notification disabled skips delivery without sending SMS", async () => {
  const db = createEnabledSmsDb({
    businessSettings: new Map([
      [
        "company-a",
        {
          company_id: "company-a",
          sms_follow_up_enabled: false,
          email_follow_up_enabled: false,
          business_hours: {},
        },
      ],
    ]),
  });

  const sendTwilioSms = mock.fn(async () => ({
    delivered: true,
    sid: "SM123",
    simulated: false as const,
  }));

  installRuntime(db, sendTwilioSms);

  const result = await notifyEmployeesOfPhoneAiLead({
    session: sampleSession(),
    leadId: "lead-1",
  });

  assert.equal(result.status, "skipped");
  assert.equal(sendTwilioSms.mock.callCount(), 0);
  assert.equal(db.notifications.length, 0);
});

test("missing notification recipient skips delivery and keeps lead path safe", async () => {
  const db = createEnabledSmsDb({
    companies: new Map([
      ["company-a", sampleCompany({ business_phone: null })],
    ]),
  });

  const sendTwilioSms = mock.fn(async () => ({
    delivered: true,
    sid: "SM123",
    simulated: false as const,
  }));

  installRuntime(db, sendTwilioSms);

  const result = await notifyEmployeesOfPhoneAiLead({
    session: sampleSession(),
    leadId: "lead-1",
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /No enabled employee notification recipients/);
  assert.equal(sendTwilioSms.mock.callCount(), 0);
});

test("existing sent SMS notification prevents duplicate delivery", async () => {
  const db = createEnabledSmsDb({
    notifications: [
      {
        id: "notification-existing",
        company_id: "company-a",
        lead_id: "lead-1",
        channel: "sms",
        recipient: "+14025550100",
        subject: null,
        message: "Already sent",
        status: "sent",
        error_message: null,
        sent_at: "2026-07-13T18:06:00.000Z",
        created_at: "2026-07-13T18:06:00.000Z",
        notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND,
      },
    ],
  });

  const sendTwilioSms = mock.fn(async () => ({
    delivered: true,
    sid: "SM999",
    simulated: false as const,
  }));

  installRuntime(db, sendTwilioSms);

  const result = await notifyEmployeesOfPhoneAiLead({
    session: sampleSession(),
    leadId: "lead-1",
  });

  assert.equal(result.status, "sent");
  assert.equal(sendTwilioSms.mock.callCount(), 0);
  assert.equal(db.notifications.length, 1);
});

test("correct company recipient receives SMS for isolated companies", async () => {
  const db = createEnabledSmsDb({
    companies: new Map([
      ["company-a", sampleCompany({ business_phone: "(402) 555-0100" })],
      ["company-b", sampleCompany({ id: "company-b", business_phone: "(402) 555-0200" })],
    ]),
    leads: new Map([
      ["lead-a", sampleLead({ id: "lead-a", company_id: "company-a" })],
      ["lead-b", sampleLead({ id: "lead-b", company_id: "company-b", full_name: "Bob Jones" })],
    ]),
    businessSettings: new Map([
      [
        "company-a",
        {
          company_id: "company-a",
          sms_follow_up_enabled: true,
          email_follow_up_enabled: false,
          business_hours: {},
        },
      ],
      [
        "company-b",
        {
          company_id: "company-b",
          sms_follow_up_enabled: true,
          email_follow_up_enabled: false,
          business_hours: {},
        },
      ],
    ]),
  });

  const sendTwilioSms = mock.fn(async () => ({
    delivered: true,
    sid: "SM123",
    simulated: false as const,
  }));

  installRuntime(db, sendTwilioSms);

  const result = await notifyEmployeesOfPhoneAiLead({
    session: sampleSession({
      company_id: "company-b",
      collected_fields: {
        full_name: "Bob Jones",
        problem_description: "Hail damage",
        summary_confirmed: true,
      },
    }),
    leadId: "lead-b",
  });

  assert.equal(result.status, "sent");
  assert.equal(sendTwilioSms.mock.callCount(), 1);
  assert.equal(sendTwilioSms.mock.calls[0]?.arguments[0], "+14025550200");
  assert.match(String(sendTwilioSms.mock.calls[0]?.arguments[1]), /Bob Jones/);
});
