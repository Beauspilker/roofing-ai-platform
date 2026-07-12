-- Roofing AI Platform — lead_notes table
-- Run in Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Prerequisites:
--   - public.companies and public.leads already exist
--
-- If you previously ran supabase/version_1_phase_2_tables.sql with a `body`
-- column instead of `note`, run this first:
--   alter table public.lead_notes rename column body to note;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lead_notes_note_not_empty check (length(trim(note)) > 0)
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
