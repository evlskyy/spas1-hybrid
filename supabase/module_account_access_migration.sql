create table if not exists public.spas1_module_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sppg_id uuid not null references public.spas1_organizations(id),
  employee_id text not null,
  username text not null unique,
  module_access text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sppg_id, employee_id),
  check (module_access <@ array['stok', 'bank_menu', 'persiapan']::text[])
);

alter table public.spas1_module_accounts enable row level security;
revoke all on public.spas1_module_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.spas1_module_accounts to service_role;
drop policy if exists "Module account tenant isolation" on public.spas1_module_accounts;
create policy "Module account tenant isolation"
on public.spas1_module_accounts as restrictive for all to authenticated
using (sppg_id = public.spas1_current_sppg_id())
with check (sppg_id = public.spas1_current_sppg_id());

create or replace function public.spas1_has_module_access(p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_module is null or p_module not in ('stok', 'bank_menu', 'persiapan') then false
    when auth.jwt() -> 'app_metadata' ->> 'role' = 'admin' then
      public.spas1_current_sppg_id() is not null
    when auth.jwt() -> 'app_metadata' ->> 'role' = 'module' then
      exists (
        select 1
        from public.spas1_module_accounts as module_account
        join public."MODUL1_DataRelawan" as employee
          on employee."ID Relawan"::text = module_account.employee_id
         and employee.sppg_id = module_account.sppg_id
        where module_account.user_id = auth.uid()
          and module_account.sppg_id = public.spas1_current_sppg_id()
          and module_account.status = 'active'
          and module_account.module_access @> array[p_module]::text[]
          and employee."Status Akun" = 'Aktif'
      )
    else false
  end
$$;
revoke all on function public.spas1_has_module_access(text) from public, anon;
grant execute on function public.spas1_has_module_access(text) to authenticated, service_role;

drop policy if exists "Bank menu admin module manage" on public.modul2_bank_menu;
create policy "Bank menu authorized manage"
on public.modul2_bank_menu for all to authenticated
using (public.spas1_has_module_access('bank_menu'))
with check (public.spas1_has_module_access('bank_menu'));
create policy "Bank menu tenant read"
on public.modul2_bank_menu for select to authenticated
using (public.spas1_current_sppg_id() is not null);

drop policy if exists "Bank menu period admin module manage" on public.modul2_bank_menu_period;
create policy "Bank menu period authorized manage"
on public.modul2_bank_menu_period for all to authenticated
using (public.spas1_has_module_access('bank_menu'))
with check (public.spas1_has_module_access('bank_menu'));

drop policy if exists "Stock admin module manage" on public.modul3_stok_logistik;
create policy "Stock authorized manage"
on public.modul3_stok_logistik for all to authenticated
using (public.spas1_has_module_access('stok'))
with check (public.spas1_has_module_access('stok'));
create policy "Preparation reads stock items"
on public.modul3_stok_logistik for select to authenticated
using (public.spas1_has_module_access('persiapan'));

drop policy if exists "Stock movement admin module access" on public.modul3_stok_logistik_transaksi;
create policy "Stock movement authorized read"
on public.modul3_stok_logistik_transaksi for select to authenticated
using (
  public.spas1_has_module_access('stok')
  or public.spas1_has_module_access('persiapan')
);

drop policy if exists "Daily stock purchase admin read" on public.modul3_stok_logistik_belanja_harian;
create policy "Daily stock purchase authorized read"
on public.modul3_stok_logistik_belanja_harian for select to authenticated
using (public.spas1_has_module_access('stok'));

do $$
begin
  if to_regclass('public.modul3_stok_logistik_kitchen_demo') is not null then
    drop policy if exists "Kitchen demo admin module manage" on public.modul3_stok_logistik_kitchen_demo;
    create policy "Kitchen demo admin manage"
    on public.modul3_stok_logistik_kitchen_demo for all to authenticated
    using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
    with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
  end if;
end
$$;

drop policy if exists "Kitchen usage admin module read" on public.modul3_stok_logistik_pemakaian_harian;
create policy "Kitchen usage authorized read"
on public.modul3_stok_logistik_pemakaian_harian for select to authenticated
using (
  public.spas1_has_module_access('stok')
  or public.spas1_has_module_access('persiapan')
);

do $$
declare
  table_name text;
  module_table text;
begin
  foreach table_name in array array[
    'MODUL4_AnggaranPO',
    'MODUL4_CloudSync',
    'MODUL4_HACCP',
    'MODUL4_JadwalDistribusi',
    'MODUL4_Joblist',
    'MODUL4_PosterAKG',
    'MODUL4_Resep',
    'MODUL4_TargetPorsi'
  ] loop
    module_table := format('%I', table_name);
    execute format('drop policy if exists %I on public.%s', table_name || '_admin_module_access', module_table);
    execute format(
      'create policy %I on public.%s for all to authenticated using (public.spas1_has_module_access(''persiapan'')) with check (public.spas1_has_module_access(''persiapan''))',
      table_name || '_preparation_access',
      module_table
    );
  end loop;
end
$$;

drop policy if exists "SPAS1_SETTINGS module operational state" on public."SPAS1_SETTINGS";
create policy "SPAS1_SETTINGS preparation operational state"
on public."SPAS1_SETTINGS" for all to authenticated
using (
  "Pengaturan" = 'operationalAppData'
  and public.spas1_has_module_access('persiapan')
)
with check (
  "Pengaturan" = 'operationalAppData'
  and public.spas1_has_module_access('persiapan')
);

drop policy if exists "Authenticated uploads for SPAS1 media" on storage.objects;
create policy "Authenticated uploads for SPAS1 media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'spas1-media'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      public.spas1_has_module_access('stok')
      and (storage.foldername(name))[2] = 'stok-logistik'
    )
    or (
      public.spas1_has_module_access('persiapan')
      and (storage.foldername(name))[2] = 'persiapan'
    )
  )
);

drop policy if exists "Authenticated updates for SPAS1 media" on storage.objects;
create policy "Authenticated updates for SPAS1 media"
on storage.objects for update to authenticated
using (
  bucket_id = 'spas1-media'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      public.spas1_has_module_access('stok')
      and (storage.foldername(name))[2] = 'stok-logistik'
    )
    or (
      public.spas1_has_module_access('persiapan')
      and (storage.foldername(name))[2] = 'persiapan'
    )
  )
)
with check (
  bucket_id = 'spas1-media'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      public.spas1_has_module_access('stok')
      and (storage.foldername(name))[2] = 'stok-logistik'
    )
    or (
      public.spas1_has_module_access('persiapan')
      and (storage.foldername(name))[2] = 'persiapan'
    )
  )
);

drop policy if exists "Authenticated deletes for SPAS1 media" on storage.objects;
create policy "Authenticated deletes for SPAS1 media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'spas1-media'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      public.spas1_has_module_access('stok')
      and (storage.foldername(name))[2] = 'stok-logistik'
    )
    or (
      public.spas1_has_module_access('persiapan')
      and (storage.foldername(name))[2] = 'persiapan'
    )
  )
);

do $$
declare
  function_signature text;
  old_guard text;
  new_guard text;
  definition text;
begin
  foreach function_signature in array array[
    'public.record_stok_logistik_movement(text,text,numeric,numeric,text,text,text,text,text,numeric)',
    'public.record_stok_logistik_daily_purchase(text,text,text,text,jsonb)',
    'public.record_stok_logistik_kitchen_usage(uuid,numeric,numeric,text)',
    'public.return_stok_logistik_kitchen_remainder(uuid)',
    'public.void_stok_logistik_transaction(uuid,text)'
  ] loop
    definition := pg_get_functiondef(function_signature::regprocedure);
    if function_signature like '%record_stok_logistik_kitchen_usage%' then
      old_guard := 'if coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', '''') not in (''admin'', ''module'') then';
      new_guard := 'if not public.spas1_has_module_access(''persiapan'') then';
    elsif function_signature like '%return_stok_logistik_kitchen_remainder%' then
      old_guard := 'if coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', '''') <> ''admin'' then';
      new_guard := 'if not public.spas1_has_module_access(''persiapan'') then';
    else
      old_guard := 'if coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', '''') <> ''admin'' then';
      new_guard := 'if not public.spas1_has_module_access(''stok'') then';
    end if;

    if position(new_guard in definition) = 0 then
      if position(old_guard in definition) = 0 then
        raise exception 'Expected authorization guard was not found in %.', function_signature;
      end if;
      execute replace(definition, old_guard, new_guard);
    end if;
  end loop;
end
$$;
