-- Roofing AI Platform — Phase 11: Customer Notifications
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.companies, public.leads, public.activity_history exist
--
-- Creates the notifications log for simulated/manual customer notifications.
-- No external SMS or email providers are integrated in this phase.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,

  channel text not null,
  recipient text not null,
  subject text,
  message text not null,
  status text not null,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),

  constraint notifications_channel_check check (
    channel in ('sms', 'email')
  ),
  constraint notifications_status_check check (
    status in ('simulated', 'queued')
  ),
  constraint notifications_recipient_not_empty check (
    length(trim(recipient)) > 0
  ),
  constraint notifications_message_not_empty check (
    length(trim(message)) > 0
  )
);

create index if not exists notifications_company_id_idx
  on public.notifications (company_id);

create index if not exists notifications_lead_id_idx
  on public.notifications (lead_id);

create index if not exists notifications_lead_id_created_at_idx
  on public.notifications (lead_id, created_at desc);

alter table public.notifications enable row level security;

create policy "Users can view notifications for their company"
  on public.notifications
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create notifications for their company"
  on public.notifications
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- Allow notification_queued activity timeline entries.
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
      'notification_queued'
    )
  );

notify pgrst, 'reload schema';
