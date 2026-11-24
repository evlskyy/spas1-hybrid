-- Remove the implicit legacy tenant only when it has no users or operational data.
-- Apply to SPAS1-Hybrid after reviewing the preflight failure output.
begin;

do $$
declare
  legacy_sppg_id constant uuid := '00000000-0000-4000-8000-000000000001';
  table_name text;
  has_legacy_rows boolean;
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
  if exists (
    select 1
    from public.spas1_memberships
    where sppg_id = legacy_sppg_id
  ) or exists (
    select 1
    from auth.users
    where raw_app_meta_data ->> 'sppg_id' = legacy_sppg_id::text
  ) then
    raise exception 'Legacy SPPG has users or memberships. Export and explicitly migrate them before applying this migration.';
  end if;

  foreach table_name in array tenant_tables loop
    execute format(
      'select exists (select 1 from public.%I where sppg_id = $1)',
      table_name
    ) into has_legacy_rows using legacy_sppg_id;
    if has_legacy_rows then
      raise exception 'Legacy SPPG has operational rows in public.%. Export and explicitly migrate them before applying this migration.', table_name;
    end if;
  end loop;

  if exists (
    select 1
    from storage.objects
    where bucket_id in ('spas1-media', 'spas1-lpdh')
      and (storage.foldername(name))[1] = 'spas1'
  ) then
    raise exception 'Legacy SPPG has Storage files under spas1/. Export and explicitly migrate them before applying this migration.';
  end if;

  delete from public.spas1_organizations
  where id = legacy_sppg_id;
end
$$;

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
    execute format(
      'alter table public.%I alter column sppg_id drop default',
      table_name
    );
    execute format(
      'alter table public.%I alter column sppg_id set default public.spas1_current_sppg_id()',
      table_name
    );
    execute format('drop policy if exists %I on public.%I', 'spas1_tenant_scope', table_name);
    execute format(
      'create policy %I on public.%I as restrictive for all to anon, authenticated using (
        auth.uid() is not null and sppg_id = public.spas1_current_sppg_id()
      ) with check (
        auth.uid() is not null and sppg_id = public.spas1_current_sppg_id()
      )',
      'spas1_tenant_scope',
      table_name
    );
  end loop;
end
$$;

create or replace function public.spas1_current_storage_folder()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.spas1_current_sppg_id()::text
$$;

commit;
