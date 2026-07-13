"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import {
  saveBusinessControlCenterSettings,
  type BusinessSettingsState,
} from "@/app/dashboard/settings/actions";
import { SettingsSuccessBanner } from "@/components/settings/SettingsSuccessBanner";
import {
  LeadFormCheckbox,
  LeadFormField,
  LeadFormSelect,
  LeadFormTextarea,
} from "@/components/leads/LeadFormFields";
import type { Company } from "@/lib/companies";
import {
  AFTER_HOURS_HANDLING_OPTIONS,
  getDayHours,
  isBusinessHoursEmpty,
  MISSED_CALL_HANDLING_OPTIONS,
  WEEKDAYS,
  type BusinessSettings,
} from "@/lib/business-settings";

const initialState: BusinessSettingsState = {
  error: null,
  success: false,
};

type BusinessControlCenterFormProps = {
  company: Company;
  settings: BusinessSettings | null;
};

function emptyValue(value: string | null | undefined): string {
  return value ?? "";
}

export function BusinessControlCenterForm({
  company,
  settings,
}: BusinessControlCenterFormProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    saveBusinessControlCenterSettings,
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  const businessHours = settings?.business_hours ?? {};
  const hoursNotConfigured = isBusinessHoursEmpty(businessHours);
  const businessHoursKey = settings?.updated_at ?? "new";

  useEffect(() => {
    if (wasPending.current && !pending && state.success) {
      router.refresh();
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    wasPending.current = pending;
  }, [pending, router, state.success]);

  return (
    <form ref={formRef} action={formAction} className="space-y-10">
      {state.success ? <SettingsSuccessBanner /> : null}

      <section className="space-y-5">
        <div>
          <h2 className="text-xl font-semibold text-white">
            Business information
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Core profile details for your roofing company.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <LeadFormField
            id="company_name"
            label="Company name"
            defaultValue={company.company_name}
            required
          />
          <LeadFormField
            id="owner_name"
            label="Owner name"
            defaultValue={company.owner_name}
            required
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <LeadFormField
            id="business_phone"
            label="Business phone"
            type="tel"
            defaultValue={emptyValue(company.business_phone)}
            placeholder="Not configured"
          />
          <LeadFormField
            id="business_email"
            label="Business email"
            type="email"
            defaultValue={emptyValue(company.business_email)}
            placeholder="Not configured"
          />
        </div>

        <LeadFormField
          id="website"
          label="Website"
          type="url"
          defaultValue={emptyValue(company.website)}
          placeholder="Not configured"
        />

        <LeadFormField
          id="address_line_1"
          label="Address"
          defaultValue={emptyValue(company.address_line_1)}
          placeholder="Not configured"
        />

        <div className="grid gap-5 sm:grid-cols-3">
          <LeadFormField
            id="city"
            label="City"
            defaultValue={emptyValue(company.city)}
            placeholder="Not configured"
          />
          <LeadFormField
            id="state"
            label="State"
            defaultValue={emptyValue(company.state)}
            placeholder="Not configured"
          />
          <LeadFormField
            id="postal_code"
            label="Postal code"
            defaultValue={emptyValue(company.postal_code)}
            placeholder="Not configured"
          />
        </div>

        <LeadFormField
          id="service_area"
          label="Service area"
          defaultValue={emptyValue(company.service_area)}
          placeholder="Not configured"
        />
      </section>

      <section
        key={businessHoursKey}
        className="space-y-5 border-t border-gray-800 pt-8"
      >
        <div>
          <h2 className="text-xl font-semibold text-white">Business hours</h2>
          <p className="mt-1 text-sm text-gray-400">
            Set your standard weekly schedule. Leave a day closed if you do not
            operate that day.
          </p>
          {hoursNotConfigured ? (
            <p className="mt-3 rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-3 text-sm text-gray-500">
              Business hours are not configured yet.
            </p>
          ) : null}
        </div>

        <input
          type="hidden"
          name="timezone"
          value={settings?.timezone ?? "America/Chicago"}
        />

        <div className="space-y-3">
          {WEEKDAYS.map((day) => {
            const dayHours = getDayHours(businessHours, day.key);

            return (
              <div
                key={day.key}
                className="grid gap-3 rounded-xl border border-gray-800 bg-black/40 p-4 sm:grid-cols-[8rem_1fr_1fr_auto]"
              >
                <p className="text-sm font-medium text-gray-300">{day.label}</p>
                <LeadFormField
                  id={`${day.key}_open`}
                  name={`${day.key}_open`}
                  label="Open"
                  type="time"
                  defaultValue={dayHours?.open ?? ""}
                />
                <LeadFormField
                  id={`${day.key}_close`}
                  name={`${day.key}_close`}
                  label="Close"
                  type="time"
                  defaultValue={dayHours?.close ?? ""}
                />
                <LeadFormCheckbox
                  id={`${day.key}_closed`}
                  name={`${day.key}_closed`}
                  label="Closed"
                  defaultChecked={false}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-5 border-t border-gray-800 pt-8">
        <div>
          <h2 className="text-xl font-semibold text-white">
            Automation preferences
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Configure how your business handles calls and follow-ups.
          </p>
          {!settings ? (
            <p className="mt-3 rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-3 text-sm text-gray-500">
              Automation preferences are using default values. Save to create
              your settings record.
            </p>
          ) : null}
        </div>

        <LeadFormSelect
          id="missed_call_handling"
          label="Missed call handling"
          defaultValue={settings?.missed_call_handling ?? ""}
          options={[...MISSED_CALL_HANDLING_OPTIONS]}
        />

        <LeadFormSelect
          id="after_hours_handling"
          label="After-hours handling"
          defaultValue={settings?.after_hours_handling ?? ""}
          options={[...AFTER_HOURS_HANDLING_OPTIONS]}
        />

        <LeadFormTextarea
          id="ai_after_hours_message"
          label="After-hours message"
          defaultValue={emptyValue(settings?.ai_after_hours_message)}
          rows={3}
        />

        <LeadFormField
          id="notification_email"
          label="Notification email"
          type="email"
          defaultValue={emptyValue(settings?.notification_email)}
          placeholder="Not configured"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <LeadFormCheckbox
            id="ai_phone_enabled"
            name="ai_phone_enabled"
            label="AI answering enabled"
            defaultChecked={settings?.ai_phone_enabled ?? true}
          />
          <LeadFormCheckbox
            id="sms_follow_up_enabled"
            name="sms_follow_up_enabled"
            label="SMS follow-up enabled"
            defaultChecked={settings?.sms_follow_up_enabled ?? false}
          />
          <LeadFormCheckbox
            id="email_follow_up_enabled"
            name="email_follow_up_enabled"
            label="Email follow-up enabled"
            defaultChecked={settings?.email_follow_up_enabled ?? false}
          />
          <LeadFormCheckbox
            id="appointment_reminders_enabled"
            name="appointment_reminders_enabled"
            label="Appointment reminders enabled"
            defaultChecked={settings?.appointment_reminders_enabled ?? false}
          />
        </div>
      </section>

      {state.error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
