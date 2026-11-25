-- Purchasing enhancements for barcode lookup, supplier catalog, PO numbering,
-- date-based purchase folders, and audited transaction editing/cancellation.
-- Apply after supabase_migration.sql, the multi-SPPG tenant migration, and
-- module_account_access_migration.sql.

create table if not exists public.spas1_stock_suppliers (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  supplier_name text not null check (length(btrim(supplier_name)) between 2 and 160),
  status text not null default 'Aktif' check (status in ('Aktif', 'Nonaktif')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create unique index if not exists spas1_stock_suppliers_name_key
  on public.spas1_stock_suppliers (sppg_id, lower(btrim(supplier_name)));

insert into public.spas1_stock_suppliers (sppg_id, supplier_name)
select distinct sppg_id, btrim("Supplier")
from public."modul3_stok_logistik_belanja_harian"
where nullif(btrim("Supplier"), '') is not null
on conflict do nothing;

create index if not exists spas1_stock_suppliers_active_idx
  on public.spas1_stock_suppliers (sppg_id, supplier_name)
  where status = 'Aktif';

alter table public.spas1_stock_suppliers enable row level security;
revoke all on public.spas1_stock_suppliers from public, anon;
grant select, insert, update on public.spas1_stock_suppliers to authenticated;

drop policy if exists "Stock supplier tenant read" on public.spas1_stock_suppliers;
create policy "Stock supplier tenant read"
on public.spas1_stock_suppliers for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and public.spas1_has_module_access('stok')
);

drop policy if exists "Stock supplier admin create" on public.spas1_stock_suppliers;
create policy "Stock supplier admin create"
on public.spas1_stock_suppliers for insert to authenticated
with check (
  sppg_id = public.spas1_current_sppg_id()
  and public.spas1_has_module_access('stok')
);

drop policy if exists "Stock supplier admin update" on public.spas1_stock_suppliers;
create policy "Stock supplier admin update"
on public.spas1_stock_suppliers for update to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and public.spas1_has_module_access('stok')
)
with check (
  sppg_id = public.spas1_current_sppg_id()
  and public.spas1_has_module_access('stok')
);

alter table public."modul3_stok_logistik"
  add column if not exists "Barcode" text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.modul3_stok_logistik'::regclass
      and conname = 'modul3_stok_logistik_barcode_check'
  ) then
    alter table public."modul3_stok_logistik"
      add constraint modul3_stok_logistik_barcode_check
      check ("Barcode" is null or "Barcode" ~ '^[A-Za-z0-9._/-]{3,80}$');
  end if;
end $$;
create unique index if not exists modul3_stok_logistik_barcode_key
  on public."modul3_stok_logistik" (sppg_id, lower("Barcode"))
  where nullif(btrim("Barcode"), '') is not null;

-- Keep the existing purchase RPC available to authorized stock-module accounts.
do $$
declare
  function_signature text := 'public.record_stok_logistik_daily_purchase(text,text,text,text,jsonb)';
  old_guard text := 'if coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', '''') <> ''admin'' then';
  new_guard text := 'if not public.spas1_has_module_access(''stok'') then';
  definition text;
begin
  definition := pg_get_functiondef(function_signature::regprocedure);
  if position(new_guard in definition) = 0 then
    if position(old_guard in definition) = 0 then
      raise exception 'Expected purchase authorization guard was not found.';
    end if;
    execute replace(definition, old_guard, new_guard);
  end if;
end
$$;

alter table public."modul3_stok_logistik_belanja_harian"
  add column if not exists "Nomor PO" text,
  add column if not exists "Supplier ID" uuid
    references public.spas1_stock_suppliers(id) on delete set null;
update public."modul3_stok_logistik_belanja_harian" as report
set "Supplier ID" = supplier.id
from public.spas1_stock_suppliers as supplier
where report."Supplier ID" is null
  and report.sppg_id = supplier.sppg_id
  and lower(btrim(report."Supplier")) = lower(btrim(supplier.supplier_name));
create unique index if not exists modul3_stok_logistik_belanja_po_key
  on public."modul3_stok_logistik_belanja_harian" (sppg_id, lower("Nomor PO"))
  where "Status" = 'Aktif' and nullif(btrim("Nomor PO"), '') is not null;

create or replace function public.record_stok_logistik_purchase_order(
  p_purchase_date date,
  p_po_number text,
  p_supplier_id uuid,
  p_note text,
  p_location text,
  p_photo_path text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_supplier_name text;
  v_report public."modul3_stok_logistik_belanja_harian"%rowtype;
  v_result jsonb;
  v_weekday text;
  v_timestamp timestamptz;
  v_line jsonb;
  v_barcode text;
  v_movement_id uuid;
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_index integer;
begin
  if not public.spas1_has_module_access('stok') then
    raise exception 'Akses Modul Stok diperlukan untuk menyimpan nota pembelian.';
  end if;
  if v_sppg_id is null then raise exception 'Keanggotaan SPPG aktif diperlukan.'; end if;
  if p_purchase_date is null
     or p_purchase_date > (now() at time zone 'Asia/Jakarta')::date
     or nullif(btrim(p_po_number), '') is null
     or length(btrim(p_po_number)) > 40
     or btrim(p_po_number) !~ '^[A-Za-z0-9][A-Za-z0-9-]{3,39}$'
     or p_supplier_id is null
     or length(coalesce(p_note, '')) > 500
     or nullif(btrim(p_location), '') is null
     or length(p_location) > 300
     or p_photo_path is null
     or p_photo_path !~ '^[a-z0-9-]+/stok-logistik/[0-9]{4}/[0-9]{2}/[0-9]{2}-[A-Za-z]+/[^/]+\.(jpeg|png|webp)$'
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 100 then
    raise exception 'Tanggal, nomor PO, pemasok, lokasi, atau rincian pembelian tidak valid.';
  end if;

  v_weekday := case extract(isodow from p_purchase_date)
    when 1 then 'Senin'
    when 2 then 'Selasa'
    when 3 then 'Rabu'
    when 4 then 'Kamis'
    when 5 then 'Jumat'
    when 6 then 'Sabtu'
    else 'Minggu'
  end;
  if v_weekday not in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat') then
    raise exception 'Tanggal nota pembelian harus hari Senin–Jumat.';
  end if;

  select supplier_name into v_supplier_name
  from public.spas1_stock_suppliers
  where id = p_supplier_id
    and sppg_id = v_sppg_id
    and status = 'Aktif';
  if not found then raise exception 'Pemasok tidak ditemukan atau tidak aktif.'; end if;

  for v_line in select value from jsonb_array_elements(p_items)
  loop
    v_barcode := nullif(btrim(coalesce(v_line ->> 'barcode', '')), '');
    if v_barcode is not null and v_barcode !~ '^[A-Za-z0-9._/-]{3,80}$' then
      raise exception 'Barcode harus berisi 3–80 karakter huruf, angka, titik, garis miring, atau tanda hubung.';
    end if;
  end loop;

  v_result := public.record_stok_logistik_daily_purchase(
    v_supplier_name,
    coalesce(btrim(p_note), ''),
    p_location,
    p_photo_path,
    p_items
  );
  if v_result is null or v_result -> 'report' ->> 'ID' is null then
    raise exception 'Nota pembelian tidak berhasil dibuat.';
  end if;

  v_timestamp := (p_purchase_date + (clock_timestamp() at time zone 'Asia/Jakarta')::time)
    at time zone 'Asia/Jakarta';
  update public."modul3_stok_logistik_belanja_harian"
  set "Tanggal" = v_timestamp,
      "Hari" = v_weekday,
      "Nomor PO" = btrim(p_po_number),
      "Supplier ID" = p_supplier_id
  where "ID" = (v_result -> 'report' ->> 'ID')::uuid
    and sppg_id = v_sppg_id
  returning * into v_report;
  if not found then raise exception 'Arsip transaksi pembelian gagal diperbarui.'; end if;

  for v_index in 0 .. jsonb_array_length(p_items) - 1
  loop
    v_line := p_items -> v_index;
    v_barcode := nullif(btrim(coalesce(v_line ->> 'barcode', '')), '');
    v_movement_id := (v_result -> 'movementIds' ->> v_index)::uuid;
    update public."modul3_stok_logistik_transaksi"
    set "Tanggal" = v_timestamp, "Hari" = v_weekday
    where "ID" = v_movement_id
      and "ID Belanja" = v_report."ID"
      and sppg_id = v_sppg_id;
    if v_barcode is not null then
      update public."modul3_stok_logistik"
      set "Barcode" = v_barcode
      where "ID"::text = (
        select "Item ID" from public."modul3_stok_logistik_transaksi"
        where "ID" = v_movement_id and sppg_id = v_sppg_id
      )
        and sppg_id = v_sppg_id;
    end if;
  end loop;

  return jsonb_build_object(
    'report', to_jsonb(v_report),
    'movementIds', v_result -> 'movementIds',
    'itemCount', v_result -> 'itemCount',
    'poNumber', v_report."Nomor PO"
  );
end;
$$;
revoke all on function public.record_stok_logistik_purchase_order(date, text, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.record_stok_logistik_purchase_order(date, text, uuid, text, text, text, jsonb) to authenticated;

create or replace function public.edit_stok_logistik_purchase_order(
  p_purchase_id uuid,
  p_purchase_date date,
  p_po_number text,
  p_supplier_id uuid,
  p_note text,
  p_location text,
  p_photo_path text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public."modul3_stok_logistik_belanja_harian"%rowtype;
  v_movement_id uuid;
  v_result jsonb;
  v_sppg_id uuid := public.spas1_current_sppg_id();
begin
  if not public.spas1_has_module_access('stok') then
    raise exception 'Akses Modul Stok diperlukan untuk mengubah nota pembelian.';
  end if;
  if p_purchase_id is null or v_sppg_id is null then
    raise exception 'Identitas transaksi atau keanggotaan SPPG tidak valid.';
  end if;
  select * into v_report
  from public."modul3_stok_logistik_belanja_harian"
  where "ID" = p_purchase_id and sppg_id = v_sppg_id
  for update;
  if not found or v_report."Status" <> 'Aktif' then
    raise exception 'Nota tidak ditemukan atau sudah dibatalkan.';
  end if;
  select "ID" into v_movement_id
  from public."modul3_stok_logistik_transaksi"
  where "ID Belanja" = p_purchase_id and sppg_id = v_sppg_id
  order by "ID"
  limit 1;
  if v_movement_id is null then raise exception 'Rincian nota pembelian tidak ditemukan.'; end if;

  perform public.void_stok_logistik_transaction(v_movement_id, 'Diedit melalui arsip transaksi pembelian.');
  v_result := public.record_stok_logistik_purchase_order(
    p_purchase_date,
    p_po_number,
    p_supplier_id,
    p_note,
    p_location,
    p_photo_path,
    p_items
  );
  return jsonb_build_object(
    'status', 'success',
    'previousPurchaseId', p_purchase_id,
    'purchase', v_result
  );
end;
$$;
revoke all on function public.edit_stok_logistik_purchase_order(uuid, date, text, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.edit_stok_logistik_purchase_order(uuid, date, text, uuid, text, text, text, jsonb) to authenticated;
