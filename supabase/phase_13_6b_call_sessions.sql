-- Roofing AI Platform — Phase 13.6B: Call session conversation memory (database foundation)
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.companies exists (supabase/companies.sql)
--   - public.set_updated_at() exists (supabase/version_1_phase_2_tables.sql)
--
-- Adds ephemeral call-session storage so the AI phone receptionist can remember
-- what a caller has already said during a live Twilio call.
--
-- Application wiring (Twilio routes) is intentionally NOT included in this phase.
-- No existing tables are modified.
--
-- Session lifetime:
--   - expires_at defaults to started_at + 4 hours (fixed window per call)
--   - recommend running cleanup_old_call_sessions() daily to purge rows older than 30 days
--     (see "Scheduled cleanup" section at the bottom of this file)

-- ---------------------------------------------------------------------------
-- 1. call_sessions
-- One row per Twilio CallSid. Stores in-call memory: collected intake fields,
-- transcript turns, and the current question being asked.
-- ---------------------------------------------------------------------------
create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  twilio_call_sid text not null,
  company_id uuid not null references public.companies (id) on delete cascade,

  caller_phone text,
  called_phone text,

  status text not null default 'active',
  -- Expected values: active, completed, expired, failed

  current_question text,

  -- Partial intake data gathered during the call (e.g. full_name, project_type).
  collected_fields jsonb not null default '{}'::jsonb,

  -- Ordered conversation turns for the live call.
  -- Expected shape: [{"role": "caller"|"assistant", "content": "...", "at": "..."}]
  transcript jsonb not null default '[]'::jsonb,

  attempt_count integer not null default 0,

  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '4 hours'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint call_sessions_twilio_call_sid_key unique (twilio_call_sid),
  constraint call_sessions_status_check check (
    status in ('active', 'completed', 'expired', 'failed')
  ),
  constraint call_sessions_attempt_count_check check (attempt_count >= 0),
  constraint call_sessions_transcript_is_array check (
    jsonb_typeof(transcript) = 'array'
  ),
  constraint call_sessions_collected_fields_is_object check (
    jsonb_typeof(collected_fields) = 'object'
  )
);

create index if not exists call_sessions_company_id_idx
  on public.call_sessions (company_id);

create index if not exists call_sessions_company_id_status_idx
  on public.call_sessions (company_id, status);

create index if not exists call_sessions_status_expires_at_idx
  on public.call_sessions (status, expires_at);

create index if not exists call_sessions_created_at_idx
  on public.call_sessions (created_at);

create index if not exists call_sessions_last_activity_at_idx
  on public.call_sessions (last_activity_at desc);

-- Keep expires_at anchored to started_at + 4 hours on insert.
create or replace function public.call_sessions_set_expires_at()
returns trigger
language plpgsql
as $$
begin
  new.expires_at := new.started_at + interval '4 hours';
  return new;
end;
$$;

drop trigger if exists call_sessions_set_expires_at on public.call_sessions;
create trigger call_sessions_set_expires_at
before insert on public.call_sessions
for each row
execute function public.call_sessions_set_expires_at();

-- Bump last_activity_at whenever a session row is updated.
create or replace function public.call_sessions_touch_last_activity()
returns trigger
language plpgsql
as $$
begin
  new.last_activity_at := now();
  return new;
end;
$$;

drop trigger if exists call_sessions_touch_last_activity on public.call_sessions;
create trigger call_sessions_touch_last_activity
before update on public.call_sessions
for each row
execute function public.call_sessions_touch_last_activity();

drop trigger if exists call_sessions_set_updated_at on public.call_sessions;
create trigger call_sessions_set_updated_at
before update on public.call_sessions
for each row
execute function public.set_updated_at();

alter table public.call_sessions enable row level security;

-- Dashboard users can inspect call sessions for their company (read-only via RLS).
-- Twilio webhook writes use SECURITY DEFINER RPCs (service_role) defined below.
create policy "Users can view call sessions for their company"
  on public.call_sessions
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. SECURITY DEFINER RPCs for server-side Twilio webhook access
-- Grant execute to service_role only. Application code will call these from
-- trusted server routes using the Supabase service role key in a later phase.
-- ---------------------------------------------------------------------------

create or replace function public.get_or_create_call_session(
  p_twilio_call_sid text,
  p_company_id uuid,
  p_caller_phone text default null,
  p_called_phone text default null
)
returns public.call_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call_sid text := nullif(trim(p_twilio_call_sid), '');
  v_session public.call_sessions;
begin
  if v_call_sid is null then
    raise exception 'Twilio CallSid is required';
  end if;

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Company not found';
  end if;

  select *
  into v_session
  from public.call_sessions
  where twilio_call_sid = v_call_sid;

  if found then
    return v_session;
  end if;

  insert into public.call_sessions (
    twilio_call_sid,
    company_id,
    caller_phone,
    called_phone
  )
  values (
    v_call_sid,
    p_company_id,
    nullif(trim(coalesce(p_caller_phone, '')), ''),
    nullif(trim(coalesce(p_called_phone, '')), '')
  )
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.update_call_session(
  p_twilio_call_sid text,
  p_current_question text default null,
  p_collected_fields jsonb default null,
  p_transcript_entry jsonb default null,
  p_status text default null,
  p_attempt_count integer default null
)
returns public.call_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call_sid text := nullif(trim(p_twilio_call_sid), '');
  v_session public.call_sessions;
  v_merged_fields jsonb;
  v_merged_transcript jsonb;
begin
  if v_call_sid is null then
    raise exception 'Twilio CallSid is required';
  end if;

  select *
  into v_session
  from public.call_sessions
  where twilio_call_sid = v_call_sid
  for update;

  if not found then
    raise exception 'Call session not found';
  end if;

  if v_session.status not in ('active') then
    raise exception 'Call session is not active';
  end if;

  if v_session.expires_at <= now() then
    update public.call_sessions
    set status = 'expired'
    where id = v_session.id;

    raise exception 'Call session has expired';
  end if;

  if p_status is not null and p_status not in ('active', 'completed', 'expired', 'failed') then
    raise exception 'Invalid call session status';
  end if;

  if p_attempt_count is not null and p_attempt_count < 0 then
    raise exception 'Attempt count cannot be negative';
  end if;

  if p_collected_fields is not null
    and jsonb_typeof(p_collected_fields) <> 'object' then
    raise exception 'collected_fields must be a JSON object';
  end if;

  if p_transcript_entry is not null
    and jsonb_typeof(p_transcript_entry) <> 'object' then
    raise exception 'transcript_entry must be a JSON object';
  end if;

  v_merged_fields := case
    when p_collected_fields is null then v_session.collected_fields
    else v_session.collected_fields || p_collected_fields
  end;

  v_merged_transcript := case
    when p_transcript_entry is null then v_session.transcript
    else v_session.transcript || jsonb_build_array(p_transcript_entry)
  end;

  update public.call_sessions
  set
    current_question = coalesce(p_current_question, current_question),
    collected_fields = v_merged_fields,
    transcript = v_merged_transcript,
    status = coalesce(p_status, status),
    attempt_count = coalesce(p_attempt_count, attempt_count)
  where id = v_session.id
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.complete_call_session(
  p_twilio_call_sid text,
  p_status text default 'completed'
)
returns public.call_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call_sid text := nullif(trim(p_twilio_call_sid), '');
  v_session public.call_sessions;
  v_final_status text := coalesce(nullif(trim(p_status), ''), 'completed');
begin
  if v_call_sid is null then
    raise exception 'Twilio CallSid is required';
  end if;

  if v_final_status not in ('completed', 'failed') then
    raise exception 'Completion status must be completed or failed';
  end if;

  update public.call_sessions
  set
    status = v_final_status,
    completed_at = now()
  where twilio_call_sid = v_call_sid
    and status = 'active'
  returning * into v_session;

  if not found then
    select *
    into v_session
    from public.call_sessions
    where twilio_call_sid = v_call_sid;

    if not found then
      raise exception 'Call session not found';
    end if;
  end if;

  return v_session;
end;
$$;

create or replace function public.mark_expired_call_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.call_sessions
  set status = 'expired'
  where status = 'active'
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.cleanup_old_call_sessions(
  p_retention_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_retention_days integer := coalesce(p_retention_days, 30);
begin
  if v_retention_days < 1 then
    raise exception 'Retention days must be at least 1';
  end if;

  delete from public.call_sessions
  where created_at < now() - make_interval(days => v_retention_days);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.get_or_create_call_session(text, uuid, text, text) from public;
revoke all on function public.update_call_session(text, text, jsonb, jsonb, text, integer) from public;
revoke all on function public.complete_call_session(text, text) from public;
revoke all on function public.mark_expired_call_sessions() from public;
revoke all on function public.cleanup_old_call_sessions(integer) from public;

grant execute on function public.get_or_create_call_session(text, uuid, text, text) to service_role;
grant execute on function public.update_call_session(text, text, jsonb, jsonb, text, integer) to service_role;
grant execute on function public.complete_call_session(text, text) to service_role;
grant execute on function public.mark_expired_call_sessions() to service_role;
grant execute on function public.cleanup_old_call_sessions(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled cleanup (manual setup — do NOT run automatically here)
--
-- Recommended daily maintenance (run in SQL Editor or pg_cron):
--
--   select public.mark_expired_call_sessions();
--   select public.cleanup_old_call_sessions(30);
--
-- Example pg_cron jobs (requires pg_cron extension enabled in Supabase):
--
--   select cron.schedule(
--     'mark-expired-call-sessions',
--     '0 * * * *',
--     $$select public.mark_expired_call_sessions();$$
--   );
--
--   select cron.schedule(
--     'cleanup-old-call-sessions',
--     '15 3 * * *',
--     $$select public.cleanup_old_call_sessions(30);$$
--   );
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
