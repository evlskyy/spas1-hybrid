-- In-progress migration for SPAS1 Hybrid. Do not execute until the frontend,
-- Edge Functions, and stock RPCs are released with this tenant schema.
begin;

create table if not exists public.spas1_organizations (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  status text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now()
);

create table if not exists public.spas1_organization_requests (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 3 and 120),
  contact_name text not null check (length(btrim(contact_name)) between 2 and 150),
  contact_email text not null check (length(contact_email) <= 254),
  contact_phone text not null check (length(btrim(contact_phone)) between 5 and 40),
  status text not null default 'pending' check (status in ('pending', 'processing', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  organization_id uuid references public.spas1_organizations(id) on delete set null
);
create unique index if not exists spas1_organization_requests_slug_active_key
  on public.spas1_organization_requests (slug)
  where status in ('pending', 'processing', 'approved');
create index if not exists spas1_organization_requests_pending_created_idx
  on public.spas1_organization_requests (created_at desc)
  where status = 'pending';

insert into public.spas1_organizations (id, slug, name, status)
values (
  '00000000-0000-4000-8000-000000000001',
  'sungai-pasir-1',
  'SPPG Sungai Pasir 1',
  'active'
)
on conflict (id) do nothing;

create table if not exists public.spas1_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sppg_id uuid not null references public.spas1_organizations(id),
  member_role text not null check (member_role in ('admin', 'module', 'employee')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

alter table public.spas1_organizations enable row level security;
alter table public.spas1_memberships enable row level security;
alter table public.spas1_organization_requests enable row level security;
drop policy if exists "Active SPPG directory read" on public.spas1_organizations;
create policy "Active SPPG directory read"
on public.spas1_organizations for select to anon, authenticated
using (status = 'active');
drop policy if exists "Users read own SPPG membership" on public.spas1_memberships;
create policy "Users read own SPPG membership"
on public.spas1_memberships for select to authenticated
using (user_id = auth.uid());
grant select on public.spas1_organizations to anon, authenticated;
grant select on public.spas1_memberships to authenticated;
revoke all on public.spas1_organization_requests from public, anon, authenticated;
grant select, insert, update, delete on public.spas1_organizations to service_role;
grant select, insert, update, delete on public.spas1_memberships to service_role;
grant select, insert, update, delete on public.spas1_organization_requests to service_role;

create or replace function public.spas1_current_sppg_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select membership.sppg_id
  from public.spas1_memberships as membership
  where membership.user_id = auth.uid()
    and membership.status = 'active'
    and membership.member_role = auth.jwt() -> 'app_metadata' ->> 'role'
$$;
revoke all on function public.spas1_current_sppg_id() from public;
grant execute on function public.spas1_current_sppg_id() to anon, authenticated, service_role;

do $$
begin
  if exists (
    select 1
    from auth.users
    where raw_app_meta_data ->> 'role' in ('admin', 'module', 'employee')
  ) then
    insert into public.spas1_memberships (user_id, sppg_id, member_role, status)
    select
      id,
      '00000000-0000-4000-8000-000000000001'::uuid,
      raw_app_meta_data ->> 'role',
      'active'
    from auth.users
    where raw_app_meta_data ->> 'role' in ('admin', 'module', 'employee')
    on conflict (user_id) do nothing;
  end if;
end $$;

update auth.users as auth_user
set raw_app_meta_data = coalesce(auth_user.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('sppg_id', membership.sppg_id::text)
from public.spas1_memberships as membership
where auth_user.id = membership.user_id
  and auth_user.raw_app_meta_data ->> 'sppg_id' is distinct from membership.sppg_id::text;

do $$
declare
  table_name text;
  has_sppg_td boolean;
  has_sppg_id boolean;
  tenant_tables text[] := array[
    'INFO_SPPG',
    'MODUL1_Absensi',
    'MODUL1_Absensi_Drafts',
    'MODUL1_DataRelawan',
    'MODUL1_PendaftaranRelawan',
    'MODUL4_AnggaranPO',
    'MODUL4_CloudSync',
    'MODUL4_HACCP',
    'MODUL4_JadwalDistribusi',
    'MODUL4_Joblist',
    'MODUL4_PosterAKG',
    'MODUL4_Resep',
    'MODUL4_TargetPorsi',
    'SPAS1_BENEFICIARIES',
    'SPAS1_MEDIA',
    'SPAS1_SETTINGS',
    'SPAS1_TEAM',
    'modul2_bank_menu',
    'modul2_bank_menu_period',
    'modul3_stok_logistik',
    'modul3_stok_logistik_belanja_harian',
    'modul3_stok_logistik_pemakaian_harian',
    'modul3_stok_logistik_transaksi',
    'spas1_lpdh_reports',
    'spas1_lpj_reports'
  ];
begin
  foreach table_name in array tenant_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Required tenant table public.% is missing.', table_name;
    end if;
  end loop;

  foreach table_name in array tenant_tables loop
    execute format(
      'select exists (
        select 1 from information_schema.columns
        where table_schema = ''public'' and table_name = %L and column_name = ''sppg_td''
      )',
      table_name
    ) into has_sppg_td;
    execute format(
      'select exists (
        select 1 from information_schema.columns
        where table_schema = ''public'' and table_name = %L and column_name = ''sppg_id''
      )',
      table_name
    ) into has_sppg_id;

    if has_sppg_td and not has_sppg_id then
      execute format('alter table public.%I rename column sppg_td to sppg_id', table_name);
    elsif has_sppg_td then
      execute format(
        'update public.%I set sppg_id = sppg_td where sppg_id is null',
        table_name
      );
      execute format('alter table public.%I drop column sppg_td', table_name);
    end if;
    execute format('alter table public.%I add column if not exists sppg_id uuid', table_name);
    execute format(
      'update public.%I set sppg_id = %L::uuid where sppg_id is null',
      table_name,
      '00000000-0000-4000-8000-000000000001'
    );
    execute format(
      'alter table public.%I alter column sppg_id set default coalesce(public.spas1_current_sppg_id(), %L::uuid)',
      table_name,
      '00000000-0000-4000-8000-000000000001'
    );
    execute format('alter table public.%I alter column sppg_id set not null', table_name);
    if not exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass(format('public.%I', table_name))
        and conname = table_name || '_sppg_id_fkey'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (sppg_id) references public.spas1_organizations(id)',
        table_name,
        table_name || '_sppg_id_fkey'
      );
    end if;
    execute format(
      'create index if not exists %I on public.%I (sppg_id)',
      table_name || '_sppg_id_idx',
      table_name
    );
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', 'spas1_tenant_scope', table_name);
    execute format(
      'create policy %I on public.%I as restrictive for all to anon, authenticated using (
        (auth.uid() is null and sppg_id = %L::uuid)
        or (auth.uid() is not null and sppg_id = public.spas1_current_sppg_id())
      ) with check (
        auth.uid() is not null and sppg_id = public.spas1_current_sppg_id()
      )',
      'spas1_tenant_scope',
      table_name,
      '00000000-0000-4000-8000-000000000001'
    );
  end loop;
end $$;

create or replace function public.spas1_enforce_tenant_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_sppg_id uuid;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  current_sppg_id := public.spas1_current_sppg_id();
  if current_sppg_id is null then
    raise exception 'An active SPPG membership is required.';
  end if;

  if tg_op = 'DELETE' then
    if old.sppg_id is distinct from current_sppg_id then
      raise exception 'Cross-SPPG data access is not allowed.';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.sppg_id is distinct from current_sppg_id then
      raise exception 'Cross-SPPG data access is not allowed.';
    end if;
    return new;
  end if;

  if old.sppg_id is distinct from current_sppg_id
      or new.sppg_id is distinct from current_sppg_id then
    raise exception 'Cross-SPPG data access is not allowed.';
  end if;
  return new;
end
$$;
revoke all on function public.spas1_enforce_tenant_scope() from public;
grant execute on function public.spas1_enforce_tenant_scope() to authenticated, service_role;

do $$
declare
  table_name text;
  tenant_tables text[] := array[
    'INFO_SPPG',
    'MODUL1_Absensi',
    'MODUL1_Absensi_Drafts',
    'MODUL1_DataRelawan',
    'MODUL1_PendaftaranRelawan',
    'MODUL4_AnggaranPO',
    'MODUL4_CloudSync',
    'MODUL4_HACCP',
    'MODUL4_JadwalDistribusi',
    'MODUL4_Joblist',
    'MODUL4_PosterAKG',
    'MODUL4_Resep',
    'MODUL4_TargetPorsi',
    'SPAS1_BENEFICIARIES',
    'SPAS1_MEDIA',
    'SPAS1_SETTINGS',
    'SPAS1_TEAM',
    'modul2_bank_menu',
    'modul2_bank_menu_period',
    'modul3_stok_logistik',
    'modul3_stok_logistik_belanja_harian',
    'modul3_stok_logistik_pemakaian_harian',
    'modul3_stok_logistik_transaksi',
    'spas1_lpdh_reports',
    'spas1_lpj_reports'
  ];
begin
  foreach table_name in array tenant_tables loop
    execute format('drop trigger if exists %I on public.%I', 'spas1_tenant_scope_guard', table_name);
    execute format(
      'create trigger %I before insert or update or delete on public.%I
       for each row execute function public.spas1_enforce_tenant_scope()',
      'spas1_tenant_scope_guard',
      table_name
    );
  end loop;
end $$;

do $$
declare
  table_name text;
  module4_tables text[] := array[
    'MODUL4_AnggaranPO',
    'MODUL4_CloudSync',
    'MODUL4_HACCP',
    'MODUL4_JadwalDistribusi',
    'MODUL4_Joblist',
    'MODUL4_PosterAKG',
    'MODUL4_Resep',
    'MODUL4_TargetPorsi'
  ];
begin
  drop index if exists public."SPAS1_SETTINGS_Pengaturan_app_key";
  create unique index if not exists "SPAS1_SETTINGS_sppg_Pengaturan_key"
    on public."SPAS1_SETTINGS" (sppg_id, "Pengaturan");
  drop index if exists public."modul2_bank_menu_period_schedule_day_key";
  create unique index if not exists "modul2_bank_menu_period_sppg_schedule_day_key"
    on public."modul2_bank_menu_period"
      (sppg_id, "Periode Bulan", "Periode Hari", "Periode Minggu", "Menu ID");
  alter table public."modul2_bank_menu_period"
    drop constraint if exists "modul2_bank_menu_period_pkey";
  create unique index if not exists "modul2_bank_menu_period_sppg_id_key"
    on public."modul2_bank_menu_period" (sppg_id, "ID");
  drop index if exists public."SPAS1_BENEFICIARIES_ID_app_key";
  create unique index if not exists "SPAS1_BENEFICIARIES_sppg_id_key"
    on public."SPAS1_BENEFICIARIES" (sppg_id, "ID");
  drop index if exists public."SPAS1_TEAM_ID_app_key";
  create unique index if not exists "SPAS1_TEAM_sppg_id_key"
    on public."SPAS1_TEAM" (sppg_id, "ID");
  drop index if exists public."modul2_bank_menu_ID_app_key";
  create unique index if not exists "modul2_bank_menu_sppg_id_key"
    on public."modul2_bank_menu" (sppg_id, "ID");
  drop index if exists public."modul3_stok_logistik_ID_app_key";
  create unique index if not exists "modul3_stok_logistik_sppg_id_key"
    on public."modul3_stok_logistik" (sppg_id, "ID");
  create unique index if not exists "MODUL1_Absensi_Drafts_sppg_id_key"
    on public."MODUL1_Absensi_Drafts" (sppg_id, "ID Absensi");
  create unique index if not exists "MODUL1_Absensi_sppg_id_key"
    on public."MODUL1_Absensi" (sppg_id, "ID Absensi");
  create unique index if not exists "spas1_lpdh_reports_sppg_date_key"
    on public.spas1_lpdh_reports (sppg_id, report_date);
  create unique index if not exists "spas1_lpj_reports_sppg_date_key"
    on public.spas1_lpj_reports (sppg_id, report_date);

  foreach table_name in array module4_tables loop
    execute format('drop index if exists public.%I', table_name || '_AppKey_app_key');
    execute format(
      'create unique index if not exists %I on public.%I (sppg_id, "AppKey")',
      table_name || '_sppg_AppKey_key',
      table_name
    );
  end loop;
end $$;

alter table public.spas1_lpdh_reports drop constraint if exists spas1_lpdh_reports_pkey;
alter table public.spas1_lpj_reports drop constraint if exists spas1_lpj_reports_pkey;

create or replace function public.spas1_current_storage_folder()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.spas1_current_sppg_id() = '00000000-0000-4000-8000-000000000001'::uuid then 'spas1'
    else public.spas1_current_sppg_id()::text
  end
$$;
revoke all on function public.spas1_current_storage_folder() from public;
grant execute on function public.spas1_current_storage_folder() to anon, authenticated, service_role;

drop policy if exists "LPDH receipts admin read" on storage.objects;
create policy "LPDH receipts admin read"
on storage.objects for select to authenticated
using (
  bucket_id = 'spas1-lpdh'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);
drop policy if exists "LPDH receipts admin upload" on storage.objects;
create policy "LPDH receipts admin upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'spas1-lpdh'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);
drop policy if exists "LPDH receipts admin delete" on storage.objects;
create policy "LPDH receipts admin delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'spas1-lpdh'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);

drop policy if exists "Authenticated uploads for SPAS1 media" on storage.objects;
create policy "Authenticated uploads for SPAS1 media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'spas1-media'
  and (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'module')
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);
drop policy if exists "Authenticated updates for SPAS1 media" on storage.objects;
create policy "Authenticated updates for SPAS1 media"
on storage.objects for update to authenticated
using (
  bucket_id = 'spas1-media'
  and (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'module')
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
)
with check (
  bucket_id = 'spas1-media'
  and (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'module')
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);
drop policy if exists "Authenticated deletes for SPAS1 media" on storage.objects;
create policy "Authenticated deletes for SPAS1 media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'spas1-media'
  and (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'module')
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
);

commit;
