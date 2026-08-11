import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { CallSession } from "./call-sessions.js";

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
    crm_lead_attempts: 0,
    ...overrides,
  };
}

test(
  "lead creation succeeds when employee notification delivery fails",
  { concurrency: false },
  async () => {
    const callSessionUpdates: Record<string, unknown>[] = [];

    mock.module("@/lib/supabase/service", {
      exports: {
        createServiceClient: () => ({
          rpc: async () => ({ data: "lead-created-1", error: null }),
          from: (table: string) => ({
            update: (payload: Record<string, unknown>) => {
              if (table === "call_sessions") {
                callSessionUpdates.push(payload);
              }

              return {
                eq: async () => ({ error: null }),
              };
            },
          }),
        }),
      },
    });

    mock.module("@/lib/call-sessions", {
      exports: {
        getCallSessionBySid: async () =>
          sampleSession({ lead_id: "lead-created-1" }),
        updateCallSession: async () => undefined,
      },
    });

    mock.module("@/lib/employee-lead-notifications", {
      exports: {
        notifyEmployeesOfPhoneAiLeadIfNeeded: async () => {
          throw new Error("Employee notification failed");
        },
      },
    });

    mock.module("@/lib/customer-confirmation-sms", {
      exports: {
        sendCustomerConfirmationSmsIfNeeded: async () => undefined,
      },
    });

    const { createCrmLeadFromCallSession } = await import("./call-lead-crm.js");

    const result = await createCrmLeadFromCallSession(sampleSession());

    assert.equal(result.status, "created");
    assert.equal(
      result.status === "created" ? result.leadId : null,
      "lead-created-1",
    );
    assert.ok(callSessionUpdates.length > 0);
  },
);
