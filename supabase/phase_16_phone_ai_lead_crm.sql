-- Roofing AI Platform — Phase 16: Automatic CRM lead creation from AI phone calls
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Prerequisites:
--   - public.companies, public.leads, public.activity_history exist
--   - public.call_sessions exists (supabase/phase_13_6b_call_sessions.sql)
--
-- Links confirmed AI phone calls to CRM leads, stores transcripts separately,
-- and tracks CRM creation status for retries.

-- ---------------------------------------------------------------------------
-- 1. Extend call_sessions with CRM linkage + retry tracking
-- ---------------------------------------------------------------------------
alter table public.call_sessions
  add column if not exists lead_id uuid references public.leads (id) on delete set null;

alter table public.call_sessions
  add column if not exists crm_lead_status text;

alter table public.call_sessions
  add column if not exists crm_lead_attempts integer not null default 0;

alter table public.call_sessions
  add column if not exists crm_lead_last_error text;

alter table public.call_sessions
  add column if not exists crm_lead_created_at timestamptz;

alter table public.call_sessions
  drop constraint if exists call_sessions_crm_lead_status_check;

alter table public.call_sessions
  add constraint call_sessions_crm_lead_status_check check (
    crm_lead_status is null
    or crm_lead_status in ('pending', 'created', 'failed', 'skipped')
  );

alter table public.call_sessions
  drop constraint if exists call_sessions_crm_lead_attempts_check;

alter table public.call_sessions
  add constraint call_sessions_crm_lead_attempts_check check (
    crm_lead_attempts >= 0
  );

create index if not exists call_sessions_lead_id_idx
  on public.call_sessions (lead_id);

create index if not exists call_sessions_crm_lead_status_idx
  on public.call_sessions (crm_lead_status);

-- ---------------------------------------------------------------------------
-- 2. Separate transcript storage for future AI reuse
-- ---------------------------------------------------------------------------
create table if not exists public.phone_call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references public.call_sessions (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  company_id uuid not null references public.companies (id) on delete cascade,
  twilio_call_sid text not null,
  transcript jsonb not null default '[]'::jsonb,
  ai_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint phone_call_transcripts_transcript_is_array check (
    jsonb_typeof(transcript) = 'array'
  ),
  constraint phone_call_transcripts_metadata_is_object check (
    jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists phone_call_transcripts_call_session_id_key
  on public.phone_call_transcripts (call_session_id);

create index if not exists phone_call_transcripts_lead_id_idx
  on public.phone_call_transcripts (lead_id);

create index if not exists phone_call_transcripts_company_id_idx
  on public.phone_call_transcripts (company_id);

create index if not exists phone_call_transcripts_twilio_call_sid_idx
  on public.phone_call_transcripts (twilio_call_sid);

alter table public.phone_call_transcripts enable row level security;

create policy "Users can view phone call transcripts for their company"
  on public.phone_call_transcripts
  for select
  to authenticated
  using (
    company_id in (
      select id from public.companies where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 3. CRM lead creation RPC (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.create_phone_ai_lead_from_call_session(
  p_twilio_call_sid text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call_sid text := nullif(trim(p_twilio_call_sid), '');
  v_session public.call_sessions;
  v_fields jsonb;
  v_lead_id uuid;
  v_full_name text;
  v_phone text;
  v_address text;
  v_project_type text;
  v_description text;
  v_insurance_claim boolean := false;
  v_appointment_at timestamptz;
  v_priority_label text;
  v_ai_summary text;
  v_confirmed boolean := false;
begin
  if v_call_sid is null then
    raise exception 'Twilio CallSid is required';
  end if;

  select *
  into v_session
  from public.call_sessions
  where twilio_call_sid = v_call_sid;

  if not found then
    raise exception 'Call session not found';
  end if;

  if v_session.lead_id is not null then
    return v_session.lead_id;
  end if;

  if v_session.status <> 'completed' then
    raise exception 'Call session is not completed';
  end if;

  v_fields := coalesce(v_session.collected_fields, '{}'::jsonb);
  v_confirmed := coalesce((v_fields->>'summary_confirmed')::boolean, false);

  if not v_confirmed then
    update public.call_sessions
    set crm_lead_status = 'skipped'
    where id = v_session.id;
    return null;
  end if;

  v_full_name := nullif(trim(coalesce(v_fields->>'full_name', '')), '');
  v_phone := nullif(trim(coalesce(v_fields->>'callback_phone', v_session.caller_phone, '')), '');
  v_address := nullif(trim(coalesce(v_fields->>'address', '')), '');
  v_ai_summary := nullif(trim(coalesce(v_fields->>'crm_summary', '')), '');

  v_project_type := nullif(trim(coalesce(v_fields->>'project_type', '')), '');
  if v_project_type ilike '%storm%' then
    v_project_type := 'storm_damage';
  elsif v_project_type ilike '%repair%' then
    v_project_type := 'repair';
  elsif v_project_type ilike '%replace%' then
    v_project_type := 'replacement';
  elsif v_project_type ilike '%inspect%' then
    v_project_type := 'inspection';
  elsif v_project_type not in ('repair', 'replacement', 'inspection', 'storm_damage', 'other') then
    v_project_type := case when v_project_type is null then null else 'other' end;
  end if;

  if coalesce(v_fields->>'insurance_claim', '') ~* '^(yes|yeah|yep|true|started|filed)' then
    v_insurance_claim := true;
  end if;

  v_description := coalesce(
    v_ai_summary,
    nullif(trim(coalesce(v_fields->>'problem_description', '')), ''),
    'AI phone intake summary pending review.'
  );

  v_priority_label := coalesce(nullif(trim(v_fields->>'priority_label'), ''), 'Low');

  v_description := v_description
    || E'\n\n[Priority: ' || v_priority_label || ']'
    || E'\n[Source: Phone AI]'
    || E'\n[CallSid: ' || v_call_sid || ']'
    || E'\n[ConversationId: ' || v_session.id::text || ']';

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
    v_session.company_id,
    coalesce(v_full_name, 'Unknown caller'),
    v_phone,
    null,
    v_address,
    null,
    null,
    null,
    'ai_phone',
    'new',
    v_project_type,
    v_description,
    v_insurance_claim,
    null
  )
  returning id into v_lead_id;

  insert into public.phone_call_transcripts (
    call_session_id,
    lead_id,
    company_id,
    twilio_call_sid,
    transcript,
    ai_summary,
    metadata
  )
  values (
    v_session.id,
    v_lead_id,
    v_session.company_id,
    v_call_sid,
    coalesce(v_session.transcript, '[]'::jsonb),
    v_ai_summary,
    jsonb_build_object(
      'priority_label', v_priority_label,
      'conversation_id', v_session.id,
      'source', 'Phone AI'
    )
  )
  on conflict (call_session_id) do update
  set
    lead_id = excluded.lead_id,
    ai_summary = excluded.ai_summary,
    transcript = excluded.transcript,
    metadata = excluded.metadata;

  insert into public.activity_history (
    company_id,
    lead_id,
    activity_type,
    summary,
    metadata
  )
  values
    (
      v_session.company_id,
      v_lead_id,
      'call_received',
      'Incoming AI Phone Call',
      jsonb_build_object(
        'twilio_call_sid', v_call_sid,
        'conversation_id', v_session.id,
        'source', 'Phone AI'
      )
    ),
    (
      v_session.company_id,
      v_lead_id,
      'lead_created',
      'Lead Created',
      jsonb_build_object(
        'source', 'ai_phone',
        'twilio_call_sid', v_call_sid,
        'conversation_id', v_session.id
      )
    ),
    (
      v_session.company_id,
      v_lead_id,
      'call_received',
      'Summary Generated',
      jsonb_build_object(
        'twilio_call_sid', v_call_sid,
        'conversation_id', v_session.id,
        'event', 'summary_generated'
      )
    ),
    (
      v_session.company_id,
      v_lead_id,
      'call_received',
      'Customer Confirmed',
      jsonb_build_object(
        'twilio_call_sid', v_call_sid,
        'conversation_id', v_session.id,
        'event', 'customer_confirmed'
      )
    );

  if nullif(trim(coalesce(v_fields->>'appointment_preference', '')), '') is not null then
    insert into public.activity_history (
      company_id,
      lead_id,
      activity_type,
      summary,
      metadata
    )
    values (
      v_session.company_id,
      v_lead_id,
      'appointment_booked',
      'Appointment Requested',
      jsonb_build_object(
        'appointment_preference', v_fields->>'appointment_preference',
        'twilio_call_sid', v_call_sid,
        'conversation_id', v_session.id
      )
    );
  end if;

  update public.call_sessions
  set
    lead_id = v_lead_id,
    crm_lead_status = 'created',
    crm_lead_created_at = now(),
    crm_lead_last_error = null
  where id = v_session.id;

  return v_lead_id;
end;
$$;

revoke all on function public.create_phone_ai_lead_from_call_session(text) from public;
grant execute on function public.create_phone_ai_lead_from_call_session(text) to service_role;

notify pgrst, 'reload schema';
