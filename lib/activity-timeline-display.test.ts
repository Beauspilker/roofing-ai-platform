import assert from "node:assert/strict";
import { test } from "node:test";

import type { ActivityHistory } from "./activity.js";
import {
  getActivityTimelineDetails,
  getActivityTypeLabel,
  getActivityTypeTone,
  getActivityTypeToneClassName,
} from "./activity-timeline-display.js";

function makeActivity(
  overrides: Partial<ActivityHistory> & Pick<ActivityHistory, "activity_type" | "summary">,
): ActivityHistory {
  return {
    id: overrides.id ?? "activity-1",
    company_id: "company-1",
    lead_id: "lead-1",
    metadata: overrides.metadata ?? {},
    actor_user_id: null,
    created_at: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

test("getActivityTypeLabel maps pipeline activity types to contractor-facing labels", () => {
  assert.equal(
    getActivityTypeLabel(
      makeActivity({ activity_type: "appointment_booked", summary: "Inspection scheduled" }),
    ),
    "Inspection",
  );
  assert.equal(
    getActivityTypeLabel(
      makeActivity({ activity_type: "follow_up_scheduled", summary: "Follow-up scheduled" }),
    ),
    "Follow-up",
  );
});

test("getActivityTypeLabel distinguishes outcome and archive status changes", () => {
  assert.equal(
    getActivityTypeLabel(
      makeActivity({
        activity_type: "status_changed",
        summary: "Lead won: $8,500.00 on Jul 15, 2026, 7:00 AM",
        metadata: { outcome: "won" },
      }),
    ),
    "Outcome",
  );
  assert.equal(
    getActivityTypeLabel(
      makeActivity({
        activity_type: "status_changed",
        summary: "Lead archived",
        metadata: { event: "lead_archived" },
      }),
    ),
    "Archive",
  );
});

test("photo uploaded details include file name from metadata", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "photo_uploaded",
      summary: "Photo uploaded",
      metadata: { file_name: "roof-damage.jpg" },
    }),
  );

  assert.deepEqual(details, ["roof-damage.jpg"]);
});

test("notification queued details include channel recipient and kind", () => {
  const customerDetails = getActivityTimelineDetails(
    makeActivity({
      activity_type: "notification_queued",
      summary: "SMS notification queued",
      metadata: { channel: "sms", recipient: "+14025550100" },
    }),
  );

  assert.deepEqual(customerDetails, ["SMS to +14025550100"]);

  const employeeDetails = getActivityTimelineDetails(
    makeActivity({
      activity_type: "notification_queued",
      summary: "Employee notification queued",
      metadata: {
        notification_kind: "employee_website_lead",
        priority: "High",
        style: "urgent",
        source: "website",
      },
    }),
  );

  assert.equal(employeeDetails[0], "Employee alert (website lead)");
  assert.equal(employeeDetails[1], "High priority · urgent alert");
});

test("follow-up details include notes when present", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "follow_up_scheduled",
      summary: "Follow-up scheduled for Jul 20, 2026, 10:00 AM",
      metadata: { follow_up_notes: "Call back about estimate" },
    }),
  );

  assert.deepEqual(details, ["Call back about estimate"]);
});

test("appointment booked details include AI preference text", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "appointment_booked",
      summary: "Appointment Requested",
      metadata: { appointment_preference: "Tuesday morning" },
    }),
  );

  assert.deepEqual(details, ["Requested: Tuesday morning"]);
});

test("call received details include event hints and source", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "call_received",
      summary: "Customer Confirmed",
      metadata: {
        event: "customer_confirmed",
        source: "Phone AI",
      },
    }),
  );

  assert.deepEqual(details, ["Customer confirmed details", "Source: AI phone"]);
});

test("website lead capture details include source and qualification", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "website_lead_captured",
      summary: "Homeowner landing lead qualified",
      metadata: {
        source: "homeowner_landing",
        qualification_status: "qualified",
      },
    }),
  );

  assert.deepEqual(details, [
    "Source: Homeowner landing",
    "Qualification: qualified",
  ]);
});

test("status changed archive and restore details use metadata", () => {
  const archivedDetails = getActivityTimelineDetails(
    makeActivity({
      activity_type: "status_changed",
      summary: "Lead archived",
      metadata: {
        event: "lead_archived",
        previous_status: "estimate_sent",
      },
    }),
  );

  assert.deepEqual(archivedDetails, ["Previous status: Estimate sent"]);

  const restoredDetails = getActivityTimelineDetails(
    makeActivity({
      activity_type: "status_changed",
      summary: "Lead restored",
      metadata: {
        event: "lead_restored",
        restored_status: "contacted",
      },
    }),
  );

  assert.deepEqual(restoredDetails, ["Restored to Contacted"]);
});

test("estimate details avoid duplicating amount already present in summary", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "estimate_sent",
      summary: "Estimate sent: $12,500.00 on Jul 18, 2026, 2:30 PM",
      metadata: {
        estimate_amount: 12500,
        source: "pipeline",
      },
    }),
  );

  assert.deepEqual(details, ["Updated via Sales pipeline"]);
});

test("missing or malformed metadata returns no detail lines", () => {
  const details = getActivityTimelineDetails(
    makeActivity({
      activity_type: "photo_uploaded",
      summary: "Photo uploaded",
      metadata: { file_name: 123 },
    }),
  );

  assert.deepEqual(details, []);
});

test("activity type tone helpers return stable classes", () => {
  const activity = makeActivity({
    activity_type: "status_changed",
    summary: "Lead won",
    metadata: { outcome: "won" },
  });

  assert.equal(getActivityTypeTone(activity), "outcome");
  assert.match(getActivityTypeToneClassName("outcome"), /text-green-300/);
});
