-- Roofing AI Platform — add archived_at to leads
-- Run in Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Adds a dedicated archive timestamp while preserving existing lead rows.
-- Archive behavior in the app sets archived_at and status = 'archived'.
-- Restore clears archived_at and returns the lead to its previous status.

alter table public.leads
add column if not exists archived_at timestamptz;

create index if not exists leads_company_id_archived_at_idx
  on public.leads (company_id, archived_at);

-- Backfill archived_at for any leads already using status = 'archived'
update public.leads
set archived_at = coalesce(archived_at, updated_at, now())
where status = 'archived'
  and archived_at is null;
