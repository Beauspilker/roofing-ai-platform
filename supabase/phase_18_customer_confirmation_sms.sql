-- Roofing AI Platform — Phase 18: Customer confirmation SMS tracking
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.call_sessions (phase 13.6B)
--   - public.notifications (phase 11, phase 17 notification_kind index)

alter table public.call_sessions
  add column if not exists customer_confirmation_status text;

alter table public.call_sessions
  add column if not exists customer_confirmation_attempts integer not null default 0;

alter table public.call_sessions
  add column if not exists customer_confirmation_last_error text;

alter table public.call_sessions
  add column if not exists customer_confirmation_sent_at timestamptz;

alter table public.call_sessions
  drop constraint if exists call_sessions_customer_confirmation_status_check;

alter table public.call_sessions
  add constraint call_sessions_customer_confirmation_status_check check (
    customer_confirmation_status is null
    or customer_confirmation_status in (
      'pending',
      'sent',
      'failed',
      'skipped'
    )
  );

alter table public.call_sessions
  drop constraint if exists call_sessions_customer_confirmation_attempts_check;

alter table public.call_sessions
  add constraint call_sessions_customer_confirmation_attempts_check check (
    customer_confirmation_attempts >= 0
  );

create index if not exists call_sessions_customer_confirmation_status_idx
  on public.call_sessions (customer_confirmation_status);

notify pgrst, 'reload schema';
