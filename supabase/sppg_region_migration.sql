-- Add structured administrative region fields for SPPG registrations.
-- Apply only to the SPAS1-Hybrid project before deploying the updated form and Edge Function.
begin;

alter table public.spas1_organization_requests
  add column if not exists province_code text,
  add column if not exists province_name text,
  add column if not exists regency_code text,
  add column if not exists regency_name text,
  add column if not exists district_code text,
  add column if not exists district_name text;

create table if not exists public.spas1_organization_regions (
  organization_id uuid primary key references public.spas1_organizations(id) on delete cascade,
  province_code text not null,
  province_name text not null,
  regency_code text not null,
  regency_name text not null,
  district_code text not null,
  district_name text not null,
  created_at timestamptz not null default now(),
  constraint spas1_organization_regions_fields_check check (
    province_code ~ '^[0-9]{2}$' and
    regency_code ~ '^[0-9]{2}[.][0-9]{2}$' and
    district_code ~ '^[0-9]{2}[.][0-9]{2}[.][0-9]{2}$' and
    left(regency_code, 2) = province_code and
    left(district_code, 5) = regency_code and
    length(btrim(province_name)) between 1 and 120 and
    length(btrim(regency_name)) between 1 and 120 and
    length(btrim(district_name)) between 1 and 120
  )
);

alter table public.spas1_organization_regions enable row level security;
revoke all on public.spas1_organization_regions from public, anon, authenticated;
grant select on public.spas1_organization_regions to authenticated;
grant all on public.spas1_organization_regions to service_role;
drop policy if exists "SPPG admins and platform admins read regions" on public.spas1_organization_regions;
create policy "SPPG admins and platform admins read regions"
on public.spas1_organization_regions for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'platform_admin') = 'true'
  or (
    organization_id = public.spas1_current_sppg_id()
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spas1_organization_requests'::regclass
      and conname = 'spas1_organization_requests_region_fields_check'
  ) then
    alter table public.spas1_organization_requests
      add constraint spas1_organization_requests_region_fields_check check (
        (
          province_code is null and province_name is null and
          regency_code is null and regency_name is null and
          district_code is null and district_name is null
        ) or (
          province_code is not null and province_name is not null and
          regency_code is not null and regency_name is not null and
          district_code is not null and district_name is not null and
          province_code ~ '^[0-9]{2}$' and
          regency_code ~ '^[0-9]{2}[.][0-9]{2}$' and
          district_code ~ '^[0-9]{2}[.][0-9]{2}[.][0-9]{2}$' and
          left(regency_code, 2) = province_code and
          left(district_code, 5) = regency_code and
          length(btrim(province_name)) between 1 and 120 and
          length(btrim(regency_name)) between 1 and 120 and
          length(btrim(district_name)) between 1 and 120
        )
      );
  end if;
end;
$$;

commit;
