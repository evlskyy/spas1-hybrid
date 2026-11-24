with required_tables(table_name) as (
  values
    ('INFO_SPPG'),
    ('MODUL1_Absensi'),
    ('MODUL1_Absensi_Drafts'),
    ('MODUL1_DataRelawan'),
    ('MODUL1_PendaftaranRelawan'),
    ('MODUL4_AnggaranPO'),
    ('MODUL4_CloudSync'),
    ('MODUL4_HACCP'),
    ('MODUL4_JadwalDistribusi'),
    ('MODUL4_Joblist'),
    ('MODUL4_PosterAKG'),
    ('MODUL4_Resep'),
    ('MODUL4_TargetPorsi'),
    ('SPAS1_BENEFICIARIES'),
    ('SPAS1_MEDIA'),
    ('SPAS1_SETTINGS'),
    ('SPAS1_TEAM'),
    ('modul2_bank_menu'),
    ('modul2_bank_menu_period'),
    ('modul3_stok_logistik'),
    ('modul3_stok_logistik_belanja_harian'),
    ('modul3_stok_logistik_pemakaian_harian'),
    ('modul3_stok_logistik_transaksi'),
    ('spas1_lpdh_reports'),
    ('spas1_lpj_reports')
),
checks as (
  select
    required.table_name,
    to_regclass(format('public.%I', required.table_name)) is not null as table_exists,
    exists (
      select 1
      from information_schema.columns as column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = required.table_name
        and column_info.column_name = 'sppg_id'
    ) as has_sppg_id,
    exists (
      select 1
      from pg_class as rel
      join pg_namespace as ns on ns.oid = rel.relnamespace
      where ns.nspname = 'public'
        and rel.relname = required.table_name
        and rel.relrowsecurity
    ) as rls_enabled,
    exists (
      select 1
      from pg_policies as pol
      where pol.schemaname = 'public'
        and pol.tablename = required.table_name
        and pol.policyname = 'spas1_tenant_scope'
        and pol.permissive = 'RESTRICTIVE'
    ) as restrictive_tenant_policy
  from required_tables as required
)
select
  count(*) as expected_tenant_tables,
  count(*) filter (where table_exists) as tables_found,
  count(*) filter (where has_sppg_id) as tables_with_sppg_id,
  count(*) filter (where rls_enabled) as tables_with_rls,
  count(*) filter (where restrictive_tenant_policy) as tables_with_tenant_policy
from checks;

select
  to_regprocedure('public.spas1_current_sppg_id()') is not null as current_sppg_helper_exists,
  to_regprocedure('public.spas1_enforce_tenant_scope()') is not null as tenant_guard_exists,
  not exists (
    select 1
    from public.spas1_organizations
    where id = '00000000-0000-4000-8000-000000000001'::uuid
  ) as legacy_sppg_removed,
  to_regprocedure('public.spas1_current_storage_folder()') is not null as tenant_storage_helper_exists;

select
  count(*) filter (
    where position(
      '00000000-0000-4000-8000-000000000001'
      in pg_get_expr(default_value.adbin, default_value.adrelid)
    ) > 0
  ) = 0 as no_legacy_tenant_defaults
from pg_attrdef as default_value
join pg_class as relation on relation.oid = default_value.adrelid
join pg_namespace as schema_info on schema_info.oid = relation.relnamespace
join pg_attribute as column_info
  on column_info.attrelid = relation.oid
  and column_info.attnum = default_value.adnum
where schema_info.nspname = 'public'
  and column_info.attname = 'sppg_id';

select
  required.bucket_id,
  exists (
    select 1 from storage.buckets as bucket where bucket.id = required.bucket_id
  ) as bucket_exists
from (values
  ('spas1-media'),
  ('spas1-lpdh'),
  ('aboutsky-private-archive')
) as required(bucket_id);
