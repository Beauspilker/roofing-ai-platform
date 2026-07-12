-- Roofing AI Platform — customer photos storage bucket
-- Run in Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Prerequisites:
--   - public.companies, public.leads, and public.customer_photos already exist
--
-- Creates a private Storage bucket for lead photos with company-scoped access.
-- Object paths must follow: company_id/lead_id/generated_filename

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-photos',
  'customer-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Company users can view customer photos"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'customer-photos'
  and (storage.foldername(name))[1] in (
    select id::text from public.companies where user_id = auth.uid()
  )
);

create policy "Company users can upload customer photos"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'customer-photos'
  and (storage.foldername(name))[1] in (
    select id::text from public.companies where user_id = auth.uid()
  )
);

create policy "Company users can delete customer photos"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'customer-photos'
  and (storage.foldername(name))[1] in (
    select id::text from public.companies where user_id = auth.uid()
  )
);
