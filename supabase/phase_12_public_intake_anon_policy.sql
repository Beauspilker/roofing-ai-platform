-- Roofing AI Platform — Phase 12 minimal public intake lookup
-- Run this FIRST if the full phase_12_website_intake.sql has not been applied yet.
--
-- Allows anonymous visitors to verify a company exists for /intake/[companyId].
-- Application code selects ONLY id and company_name for a specific company UUID.

drop policy if exists "Anonymous can read companies for public intake"
  on public.companies;

create policy "Anonymous can read companies for public intake"
  on public.companies
  for select
  to anon
  using (true);

grant select on public.companies to anon;

notify pgrst, 'reload schema';
