-- Roofing AI Platform — Phase 17: Employee lead notification tracking
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.call_sessions (phase 13.6B)
--   - public.notifications (phase 11)
--
-- Adds retry/idempotency tracking for internal employee notifications and
-- extends notification delivery statuses for SMS/email logging.

-- ---------------------------------------------------------------------------
-- 1. call_sessions: employee notification tracking
-- ---------------------------------------------------------------------------
alter table public.call_sessions
  add column if not exists employee_notification_status text;

alter table public.call_sessions
  add column if not exists employee_notification_attempts integer not null default 0;

alter table public.call_sessions
  add column if not exists employee_notification_last_error text;

alter table public.call_sessions
  add column if not exists employee_notification_sent_at timestamptz;

alter table public.call_sessions
  drop constraint if exists call_sessions_employee_notification_status_check;

alter table public.call_sessions
  add constraint call_sessions_employee_notification_status_check check (
    employee_notification_status is null
    or employee_notification_status in (
      'pending',
      'sent',
      'partial',
      'failed',
      'skipped'
    )
  );

alter table public.call_sessions
  drop constraint if exists call_sessions_employee_notification_attempts_check;

alter table public.call_sessions
  add constraint call_sessions_employee_notification_attempts_check check (
    employee_notification_attempts >= 0
  );

create index if not exists call_sessions_employee_notification_status_idx
  on public.call_sessions (employee_notification_status);

-- ---------------------------------------------------------------------------
-- 2. notifications: delivery statuses + idempotency kind
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists notification_kind text;

alter table public.notifications
  drop constraint if exists notifications_status_check;

alter table public.notifications
  add constraint notifications_status_check check (
    status in ('simulated', 'queued', 'sent', 'failed')
  );

create unique index if not exists notifications_lead_kind_channel_key
  on public.notifications (lead_id, notification_kind, channel)
  where notification_kind is not null and lead_id is not null;

notify pgrst, 'reload schema';
