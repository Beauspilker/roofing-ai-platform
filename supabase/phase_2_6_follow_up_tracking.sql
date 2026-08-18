-- Roofing AI Platform — Phase 2.6: Follow-up / Task Tracking
-- Run in Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Prerequisites:
--   - public.leads, public.activity_history exist
--   - phase_11 and phase_12 activity type migrations already applied
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS and guarded constraint replace.

-- ---------------------------------------------------------------------------
-- leads: contractor follow-up due datetime (open task only; cleared on complete)
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists follow_up_at timestamptz;

create index if not exists leads_company_id_follow_up_at_idx
  on public.leads (company_id, follow_up_at)
  where follow_up_at is not null;

-- ---------------------------------------------------------------------------
-- activity_history: allow follow-up timeline activity types
-- ---------------------------------------------------------------------------
alter table public.activity_history
  drop constraint if exists activity_history_activity_type_check;

alter table public.activity_history
  add constraint activity_history_activity_type_check check (
    activity_type in (
      'lead_created',
      'call_received',
      'call_missed',
      'note_added',
      'photo_uploaded',
      'status_changed',
      'appointment_booked',
      'appointment_updated',
      'estimate_created',
      'estimate_sent',
      'settings_updated',
      'notification_queued',
      'website_lead_captured',
      'follow_up_scheduled',
      'follow_up_rescheduled',
      'follow_up_completed'
    )
  );

notify pgrst, 'reload schema';
