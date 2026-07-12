-- Run this in the Supabase Dashboard:
-- Project → SQL Editor → New query → paste this file → Run

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_name text not null,
  owner_name text not null,
  business_phone text,
  business_email text,
  service_area text,
  years_in_business integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_user_id_key unique (user_id)
);

alter table public.companies enable row level security;

create policy "Users can view their own company"
  on public.companies
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can create their own company"
  on public.companies
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own company"
  on public.companies
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
