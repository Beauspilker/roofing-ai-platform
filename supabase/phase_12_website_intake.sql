-- Roofing AI Platform — Phase 12: Public website lead intake
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.companies, public.leads, public.activity_history exist
--
-- Adds secure RPC functions so anonymous visitors can submit website intake leads
-- without exposing private company data or bypassing company scoping.
-- No service-role key is required in the browser.

-- ---------------------------------------------------------------------------
-- 1. Anonymous company lookup for /intake/[companyId]
-- Application selects ONLY id and company_name for the requested UUID.
-- ---------------------------------------------------------------------------
drop policy if exists "Anonymous can read companies for public intake"
  on public.companies;

create policy "Anonymous can read companies for public intake"
  on public.companies
  for select
  to anon
  using (true);

grant select on public.companies to anon;

-- ---------------------------------------------------------------------------
-- 2. RPC + profile table + lead submission
-- ---------------------------------------------------------------------------
create or replace function public.get_public_intake_company(p_company_id uuid)
returns table (
  id uuid,
  company_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.company_name
  from public.companies c
  where c.id = p_company_id;
$$;

revoke all on function public.get_public_intake_company(uuid) from public;
grant execute on function public.get_public_intake_company(uuid) to anon, authenticated;

-- Public-safe company lookup table (id + company_name only).
-- Anon clients can read this table via RLS without exposing user_id or other fields.
create table if not exists public.company_intake_profiles (
  id uuid primary key references public.companies (id) on delete cascade,
  company_name text not null,
  updated_at timestamptz not null default now()
);

insert into public.company_intake_profiles (id, company_name)
select id, company_name
from public.companies
on conflict (id) do update
set
  company_name = excluded.company_name,
  updated_at = now();

create or replace function public.sync_company_intake_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_intake_profiles (id, company_name)
  values (new.id, new.company_name)
  on conflict (id) do update
  set
    company_name = excluded.company_name,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists companies_sync_intake_profile on public.companies;
create trigger companies_sync_intake_profile
after insert or update of company_name on public.companies
for each row
execute function public.sync_company_intake_profile();

alter table public.company_intake_profiles enable row level security;

drop policy if exists "Public can read company intake profiles"
  on public.company_intake_profiles;

create policy "Public can read company intake profiles"
  on public.company_intake_profiles
  for select
  to anon, authenticated
  using (true);

grant select on public.company_intake_profiles to anon, authenticated;

create or replace view public.intake_companies_public
with (security_invoker = false) as
  select id, company_name
  from public.companies;

revoke all on public.intake_companies_public from public;
grant select on public.intake_companies_public to anon, authenticated;

create or replace function public.create_website_intake_lead(
  p_company_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_address_line_1 text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_project_type text,
  p_description text,
  p_insurance_claim boolean,
  p_appointment_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_full_name text := trim(p_full_name);
  v_phone text := trim(p_phone);
  v_email text := nullif(trim(coalesce(p_email, '')), '');
  v_address text := trim(p_address_line_1);
  v_city text := trim(p_city);
  v_state text := trim(p_state);
  v_postal_code text := trim(p_postal_code);
  v_project_type text := nullif(trim(coalesce(p_project_type, '')), '');
  v_description text := trim(p_description);
begin
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Company not found';
  end if;

  if length(v_full_name) = 0 then
    raise exception 'Full name is required';
  end if;

  if length(v_phone) = 0 then
    raise exception 'Phone is required';
  end if;

  if length(v_address) = 0 then
    raise exception 'Address is required';
  end if;

  if v_project_type is null then
    raise exception 'Project type is required';
  end if;

  if v_project_type not in (
    'repair', 'replacement', 'inspection', 'storm_damage', 'other'
  ) then
    raise exception 'Invalid project type';
  end if;

  if length(v_description) = 0 then
    raise exception 'Description is required';
  end if;

  insert into public.leads (
    company_id,
    full_name,
    phone,
    email,
    address_line_1,
    city,
    state,
    postal_code,
    source,
    status,
    project_type,
    description,
    insurance_claim,
    appointment_at
  )
  values (
    p_company_id,
    v_full_name,
    v_phone,
    v_email,
    v_address,
    nullif(v_city, ''),
    nullif(v_state, ''),
    nullif(v_postal_code, ''),
    'website',
    'new',
    v_project_type,
    v_description,
    coalesce(p_insurance_claim, false),
    p_appointment_at
  )
  returning id into v_lead_id;

  insert into public.activity_history (
    company_id,
    lead_id,
    activity_type,
    summary,
    metadata
  )
  values (
    p_company_id,
    v_lead_id,
    'website_lead_captured',
    'Website lead captured',
    jsonb_build_object('source', 'website')
  );

  return v_lead_id;
end;
$$;

revoke all on function public.create_website_intake_lead(
  uuid, text, text, text, text, text, text, text, text, text, boolean, timestamptz
) from public;

grant execute on function public.create_website_intake_lead(
  uuid, text, text, text, text, text, text, text, text, text, boolean, timestamptz
) to anon, authenticated;

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
      'website_lead_captured'
    )
  );

notify pgrst, 'reload schema';
