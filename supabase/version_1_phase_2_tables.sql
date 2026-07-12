-- Roofing AI Platform — Version 1 Phase 2 tables
-- Run in Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Prerequisites:
--   - public.companies already exists (see supabase/companies.sql)
--
-- This migration adds the remaining Version 1 tables:
--   1. leads
--   2. lead_notes
--   3. customer_photos
--   4. activity_history
--   5. business_settings
--
-- Every table is scoped to a company via company_id.
-- Row Level Security (RLS) mirrors the companies table pattern:
-- authenticated users can only access rows for their own company.

-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at in sync on row changes
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. leads
-- Core customer/lead records for a roofing company.
-- Supports Version 1 workflows: AI phone intake, appointment booking,
-- estimate tracking, and basic pipeline status management.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- Contact information captured from calls, forms, or manual entry
  full_name text not null,
  phone text,
  email text,
  address_line_1 text,
  city text,
  state text,
  postal_code text,

  -- Intake context
  source text not null default 'manual',
  -- Expected values: ai_phone, website, referral, manual, other

  status text not null default 'new',
  -- Expected values: new, contacted, appointment_scheduled, estimate_sent, won, lost, archived

  project_type text,
  -- Expected values: repair, replacement, inspection, storm_damage, other

  description text,
  insurance_claim boolean not null default false,

  -- Scheduling and estimate fields for Version 1 sales flow
  appointment_at timestamptz,
  estimate_amount numeric(12, 2),
  estimate_sent_at timestamptz,
  last_contacted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leads_status_check check (
    status in (
      'new',
      'contacted',
      'appointment_scheduled',
      'estimate_sent',
      'won',
      'lost',
      'archived'
    )
  ),
  constraint leads_source_check check (
    source in ('ai_phone', 'website', 'referral', 'manual', 'other')
  ),
  constraint leads_estimate_amount_check check (
    estimate_amount is null or estimate_amount >= 0
  )
);

create index if not exists leads_company_id_idx
  on public.leads (company_id);

create index if not exists leads_company_id_status_idx
  on public.leads (company_id, status);

create index if not exists leads_company_id_created_at_idx
  on public.leads (company_id, created_at desc);

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row
execute function public.set_updated_at();

alter table public.leads enable row level security;

create policy "Users can view leads for their company"
  on public.leads
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create leads for their company"
  on public.leads
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can update leads for their company"
  on public.leads
  for update
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  )
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can delete leads for their company"
  on public.leads
  for delete
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. lead_notes
-- Free-form notes attached to a lead (call summaries, follow-ups, etc.).
-- Each note belongs to one lead and one company.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  -- Optional link to the authenticated user who wrote the note
  author_user_id uuid references auth.users (id) on delete set null,

  body text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lead_notes_body_not_empty check (length(trim(body)) > 0)
);

create index if not exists lead_notes_company_id_idx
  on public.lead_notes (company_id);

create index if not exists lead_notes_lead_id_idx
  on public.lead_notes (lead_id);

create index if not exists lead_notes_lead_id_created_at_idx
  on public.lead_notes (lead_id, created_at desc);

drop trigger if exists lead_notes_set_updated_at on public.lead_notes;
create trigger lead_notes_set_updated_at
before update on public.lead_notes
for each row
execute function public.set_updated_at();

alter table public.lead_notes enable row level security;

create policy "Users can view lead notes for their company"
  on public.lead_notes
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create lead notes for their company"
  on public.lead_notes
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can update lead notes for their company"
  on public.lead_notes
  for update
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  )
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can delete lead notes for their company"
  on public.lead_notes
  for delete
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 3. customer_photos
-- Photos tied to a lead (roof damage, before/after, etc.).
-- Stores the Supabase Storage object path; the app generates public/signed URLs.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  storage_path text not null,
  file_name text,
  mime_type text,
  caption text,

  photo_type text not null default 'other',
  -- Expected values: damage, roof_overview, before, after, other

  uploaded_by_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_photos_storage_path_not_empty check (
    length(trim(storage_path)) > 0
  ),
  constraint customer_photos_photo_type_check check (
    photo_type in ('damage', 'roof_overview', 'before', 'after', 'other')
  )
);

create index if not exists customer_photos_company_id_idx
  on public.customer_photos (company_id);

create index if not exists customer_photos_lead_id_idx
  on public.customer_photos (lead_id);

create index if not exists customer_photos_lead_id_created_at_idx
  on public.customer_photos (lead_id, created_at desc);

drop trigger if exists customer_photos_set_updated_at on public.customer_photos;
create trigger customer_photos_set_updated_at
before update on public.customer_photos
for each row
execute function public.set_updated_at();

alter table public.customer_photos enable row level security;

create policy "Users can view customer photos for their company"
  on public.customer_photos
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create customer photos for their company"
  on public.customer_photos
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can update customer photos for their company"
  on public.customer_photos
  for update
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  )
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can delete customer photos for their company"
  on public.customer_photos
  for delete
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 4. activity_history
-- Append-only event log for lead and company activity.
-- Used for timeline views: calls, status changes, notes, photos, appointments,
-- and estimates in Version 1.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- Nullable so company-level events can be logged without a specific lead
  lead_id uuid references public.leads (id) on delete cascade,

  activity_type text not null,
  -- Expected values: lead_created, call_received, call_missed, note_added,
  -- photo_uploaded, status_changed, appointment_booked, appointment_updated,
  -- estimate_created, estimate_sent, settings_updated

  summary text not null,

  -- Flexible payload for event-specific details (old/new status, amounts, etc.)
  metadata jsonb not null default '{}'::jsonb,

  actor_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  constraint activity_history_summary_not_empty check (
    length(trim(summary)) > 0
  ),
  constraint activity_history_activity_type_check check (
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
      'settings_updated'
    )
  )
);

create index if not exists activity_history_company_id_idx
  on public.activity_history (company_id);

create index if not exists activity_history_lead_id_idx
  on public.activity_history (lead_id);

create index if not exists activity_history_company_id_created_at_idx
  on public.activity_history (company_id, created_at desc);

alter table public.activity_history enable row level security;

create policy "Users can view activity history for their company"
  on public.activity_history
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create activity history for their company"
  on public.activity_history
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- Activity history is append-only in Version 1 (no update/delete policies).

-- ---------------------------------------------------------------------------
-- 5. business_settings
-- One settings row per company for Version 1 operational configuration:
-- AI phone behavior, business hours, and estimate defaults.
-- Profile fields (name, phone, service area) remain on public.companies.
-- ---------------------------------------------------------------------------
create table if not exists public.business_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  timezone text not null default 'America/Chicago',

  -- Example shape: {"monday": {"open": "08:00", "close": "17:00"}, ...}
  business_hours jsonb not null default '{}'::jsonb,

  ai_phone_enabled boolean not null default true,
  ai_greeting_message text,
  ai_after_hours_message text,

  appointment_buffer_minutes integer not null default 30,
  default_estimate_valid_days integer not null default 30,

  notification_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_settings_company_id_key unique (company_id),
  constraint business_settings_appointment_buffer_check check (
    appointment_buffer_minutes >= 0
  ),
  constraint business_settings_estimate_valid_days_check check (
    default_estimate_valid_days > 0
  )
);

create index if not exists business_settings_company_id_idx
  on public.business_settings (company_id);

drop trigger if exists business_settings_set_updated_at on public.business_settings;
create trigger business_settings_set_updated_at
before update on public.business_settings
for each row
execute function public.set_updated_at();

alter table public.business_settings enable row level security;

create policy "Users can view business settings for their company"
  on public.business_settings
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can create business settings for their company"
  on public.business_settings
  for insert
  to authenticated
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

create policy "Users can update business settings for their company"
  on public.business_settings
  for update
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  )
  with check (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );
