"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  sendCustomerNotification,
  type SendCustomerNotificationState,
} from "@/app/dashboard/leads/[id]/notifications/actions";
import {
  LeadFormField,
  LeadFormTextarea,
} from "@/components/leads/LeadFormFields";
import type { Lead } from "@/lib/leads";
import {
  formatNotificationChannel,
  formatNotificationDate,
  formatNotificationPreview,
  formatNotificationStatus,
  formatNotificationTime,
  type Notification,
  type NotificationChannel,
} from "@/lib/notifications";

const initialState: SendCustomerNotificationState = {
  error: null,
  success: false,
};

type CustomerNotificationsSectionProps = {
  lead: Lead;
  notifications: Notification[];
  smsFollowUpEnabled: boolean;
  emailFollowUpEnabled: boolean;
  canSend: boolean;
};

function defaultRecipient(
  channel: NotificationChannel,
  lead: Lead,
): string {
  if (channel === "sms") {
    return lead.phone?.trim() ?? "";
  }

  return lead.email?.trim() ?? "";
}

export function CustomerNotificationsSection({
  lead,
  notifications,
  smsFollowUpEnabled,
  emailFollowUpEnabled,
  canSend,
}: CustomerNotificationsSectionProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  const [channel, setChannel] = useState<NotificationChannel>("sms");
  const [recipient, setRecipient] = useState(defaultRecipient("sms", lead));
  const [state, formAction, pending] = useActionState(
    sendCustomerNotification,
    initialState,
  );
  const historyKey = notifications[0]?.created_at ?? "empty";

  useEffect(() => {
    setRecipient(defaultRecipient(channel, lead));
  }, [channel, lead]);

  useEffect(() => {
    if (wasPending.current && !pending && state.success) {
      formRef.current?.reset();
      setChannel("sms");
      setRecipient(defaultRecipient("sms", lead));
      router.refresh();
    }

    wasPending.current = pending;
  }, [lead, pending, router, state.success]);

  const showSmsWarning = channel === "sms" && !smsFollowUpEnabled;
  const showEmailWarning = channel === "email" && !emailFollowUpEnabled;

  return (
    <section className="mt-10 space-y-6 border-t border-gray-800 pt-8">
      <div>
        <h2 className="text-xl font-semibold text-white">
          Customer Notifications
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          Send a simulated SMS or email notification. No messages are delivered
          to external providers in this phase.
        </p>
      </div>

      {!canSend ? (
        <p className="rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-8 text-center text-sm text-gray-500">
          Archived leads cannot receive new notifications.
        </p>
      ) : (
        <form
          ref={formRef}
          action={formAction}
          className="space-y-4 rounded-xl border border-gray-800 bg-black/40 p-4"
        >
          <input type="hidden" name="lead_id" value={lead.id} />

          {state.success ? (
            <div className="rounded-xl border border-green-900/50 bg-green-950/40 px-4 py-3 text-sm text-green-200">
              Notification queued successfully. Delivery is simulated only.
            </div>
          ) : null}

          <div>
            <label
              htmlFor="channel"
              className="block text-sm font-medium text-gray-300"
            >
              Channel
            </label>
            <select
              id="channel"
              name="channel"
              value={channel}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "sms" || value === "email") {
                  setChannel(value);
                }
              }}
              className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition focus:border-blue-600"
            >
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </div>

          {showSmsWarning ? (
            <p className="rounded-xl border border-yellow-900/50 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200">
              SMS follow-up is disabled in Business Control Center. Manual
              simulated sending is still allowed.
            </p>
          ) : null}

          {showEmailWarning ? (
            <p className="rounded-xl border border-yellow-900/50 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200">
              Email follow-up is disabled in Business Control Center. Manual
              simulated sending is still allowed.
            </p>
          ) : null}

          <LeadFormField
            id="recipient"
            label={channel === "sms" ? "Recipient phone" : "Recipient email"}
            type={channel === "sms" ? "tel" : "email"}
            value={recipient}
            onChange={setRecipient}
            required
            placeholder={
              channel === "sms" ? "Lead phone number" : "Lead email address"
            }
          />

          {channel === "email" ? (
            <LeadFormField
              id="subject"
              label="Subject"
              required
              placeholder="Notification subject"
            />
          ) : null}

          <LeadFormTextarea
            id="message"
            label="Message"
            rows={4}
            defaultValue=""
          />

          {state.error ? (
            <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
              {state.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Sending..." : "Send Notification"}
          </button>
        </form>
      )}

      <div key={historyKey} className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.15em] text-gray-400">
          Notification history
        </h3>

        {notifications.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-8 text-center text-sm text-gray-500">
            No notifications sent yet.
          </p>
        ) : (
          <ul className="space-y-4">
            {notifications.map((notification) => (
              <li
                key={notification.id}
                className="rounded-xl border border-gray-800 bg-black/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-blue-900/50 bg-blue-950/40 px-2 py-1 text-xs font-semibold text-blue-200">
                    {formatNotificationChannel(notification.channel)}
                  </span>
                  <span className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300">
                    {formatNotificationStatus(notification.status)}
                  </span>
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  <div>
                    <dt className="text-gray-500">Recipient</dt>
                    <dd className="text-gray-200">{notification.recipient}</dd>
                  </div>
                  {notification.subject ? (
                    <div>
                      <dt className="text-gray-500">Subject</dt>
                      <dd className="text-gray-200">{notification.subject}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-gray-500">Message</dt>
                    <dd className="whitespace-pre-wrap text-gray-200">
                      {formatNotificationPreview(notification.message)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  <span>{formatNotificationDate(notification.created_at)}</span>
                  <span>{formatNotificationTime(notification.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
