-- Roofing AI Platform — Phase 10: Business Control Center columns
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Why this migration is required:
--   public.companies (supabase/companies.sql) only includes basic profile fields.
--   The Business Control Center also needs website and address fields on companies,
--   plus automation preference columns on public.business_settings.
--
-- Prerequisites:
--   - public.companies exists (supabase/companies.sql)
--   - public.business_settings exists (supabase/version_1_phase_2_tables.sql)
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS and guarded constraints.

-- ---------------------------------------------------------------------------
-- companies: profile fields missing from the original table
-- ---------------------------------------------------------------------------
alter table public.companies add column if not exists website text;
alter table public.companies add column if not exists address_line_1 text;
alter table public.companies add column if not exists city text;
alter table public.companies add column if not exists state text;
alter table public.companies add column if not exists postal_code text;

-- ---------------------------------------------------------------------------
-- business_settings: automation preference fields missing from phase 2 table
-- ---------------------------------------------------------------------------
alter table public.business_settings
  add column if not exists missed_call_handling text;

alter table public.business_settings
  add column if not exists sms_follow_up_enabled boolean not null default false;

alter table public.business_settings
  add column if not exists email_follow_up_enabled boolean not null default false;

alter table public.business_settings
  add column if not exists appointment_reminders_enabled boolean not null default false;

alter table public.business_settings
  add column if not exists after_hours_handling text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'business_settings_missed_call_handling_check'
  ) then
    alter table public.business_settings
      add constraint business_settings_missed_call_handling_check check (
        missed_call_handling is null
        or missed_call_handling in ('voicemail', 'sms_follow_up', 'manual_review')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'business_settings_after_hours_handling_check'
  ) then
    alter table public.business_settings
      add constraint business_settings_after_hours_handling_check check (
        after_hours_handling is null
        or after_hours_handling in ('ai_message', 'voicemail', 'disabled')
      );
  end if;
end $$;

-- Refresh Supabase PostgREST schema cache so new columns are available immediately.
notify pgrst, 'reload schema';
