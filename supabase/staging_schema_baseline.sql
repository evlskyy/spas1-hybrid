-- Schema-only baseline generated for the SPAS1-Hybrid staging project.
-- Source: SPAS1-Database schema export; no row data is included.
-- Apply only to the empty staging project, never to SPAS1-Database.
-- Supabase-managed functions and default privileges are intentionally omitted.

BEGIN;

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.11
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: aboutsky_allow_contact(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.aboutsky_allow_contact(p_ip_hash text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  current_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  insert into public.aboutsky_contact_rate_limits as current_limit
    (ip_hash, window_started_at, request_count)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update
  set window_started_at = case
        when current_limit.window_started_at <= now() - interval '1 hour'
          then now()
        else current_limit.window_started_at
      end,
      request_count = case
        when current_limit.window_started_at <= now() - interval '1 hour'
          then 1
        else least(current_limit.request_count + 1, 6)
      end
  returning request_count into current_count;

  delete from public.aboutsky_contact_rate_limits
  where window_started_at < now() - interval '1 hour';

  return current_count <= 5;
end;
$_$;


--
-- Name: guard_stok_logistik_return_void(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_stok_logistik_return_void() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if old."Status" = 'Aktif' and new."Status" = 'Dibatalkan' then
    if old."Tipe" = 'Keluar' and exists (
      select 1 from public."modul3_stok_logistik_pemakaian_harian" usage
      join public."modul3_stok_logistik_transaksi" returned
        on returned."ID" = usage."Transaksi Pengembalian ID"
      where usage."Transaksi Keluar ID" = old."ID"
        and usage."Dikembalikan Pada" is not null
        and returned."Status" = 'Aktif'
    ) then
      raise exception 'Batalkan transaksi pengembalian sisa terlebih dahulu sebelum membatalkan stok keluar.';
    end if;
    if old."Transaksi Referensi ID" is not null then
      update public."modul3_stok_logistik_pemakaian_harian"
      set "Jumlah Dikembalikan" = 0, "Dikembalikan Pada" = null, "Transaksi Pengembalian ID" = null
      where "Transaksi Pengembalian ID" = old."ID";
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: record_stok_logistik_daily_purchase(text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_stok_logistik_daily_purchase(p_supplier text, p_note text, p_location text, p_photo_path text, p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_report public."modul3_stok_logistik_belanja_harian"%rowtype;
  v_item public."modul3_stok_logistik"%rowtype;
  v_movement public."modul3_stok_logistik_transaksi"%rowtype;
  v_line jsonb;
  v_category text;
  v_name text;
  v_unit text;
  v_small_unit text;
  v_conversion_factor numeric;
  v_quantity numeric;
  v_unit_price numeric;
  v_before numeric;
  v_after numeric;
  v_total numeric := 0;
  v_item_count integer := 0;
  v_new_id bigint;
  v_sequence text;
  v_timestamp timestamptz := clock_timestamp();
  v_weekday text;
  v_photo_folder text;
  v_movement_ids jsonb := '[]'::jsonb;
  v_category_before text;
  v_price_before numeric;
  v_supplier_before text;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat mencatat pembelian stok harian.';
  end if;
  if nullif(btrim(p_location), '') is null or length(p_location) > 300
     or length(coalesce(p_supplier, '')) > 160 or length(coalesce(p_note, '')) > 500
     or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'Data laporan belanja harian tidak valid.';
  end if;
  v_weekday := case extract(isodow from (v_timestamp at time zone 'Asia/Jakarta'))
    when 1 then 'Senin' when 2 then 'Selasa' when 3 then 'Rabu'
    when 4 then 'Kamis' when 5 then 'Jumat' when 6 then 'Sabtu' else 'Minggu'
  end;
  if v_weekday not in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat') then
    raise exception 'Transaksi operasional hanya dapat dicatat pada hari Senin–Jumat.';
  end if;
  v_photo_folder := 'spas1/stok-logistik/' || to_char(v_timestamp at time zone 'Asia/Jakarta', 'YYYY/MM/DD') || '-' || v_weekday || '/';
  if p_photo_path is null or p_photo_path not like v_photo_folder || '%'
     or p_photo_path !~ '^spas1/stok-logistik/[0-9]{4}/[0-9]{2}/[0-9]{2}-[A-Za-z]+/[^/]+\.(jpeg|png|webp)$' then
    raise exception 'Foto nota harus disimpan pada folder tanggal transaksi.';
  end if;

  insert into public."modul3_stok_logistik_belanja_harian" (
    "Tanggal", "Hari", "Supplier", "Catatan", "Lokasi", "Foto Path", "Jumlah Item", "Dibuat Oleh"
  ) values (
    v_timestamp, v_weekday, coalesce(btrim(p_supplier), ''), coalesce(btrim(p_note), ''),
    btrim(p_location), p_photo_path, jsonb_array_length(p_items), auth.uid()
  ) returning * into v_report;

  lock table public."modul3_stok_logistik" in share row exclusive mode;
  v_sequence := pg_get_serial_sequence('public.modul3_stok_logistik', 'ID');
  for v_line in select value from jsonb_array_elements(p_items)
  loop
    v_category_before := null;
    v_price_before := null;
    v_supplier_before := null;
    v_category := btrim(coalesce(v_line ->> 'category', ''));
    v_name := btrim(coalesce(v_line ->> 'name', ''));
    v_unit := btrim(coalesce(v_line ->> 'unit', ''));
    v_small_unit := btrim(coalesce(v_line ->> 'smallUnit', ''));
    v_conversion_factor := nullif(v_line ->> 'conversionFactor', '')::numeric;
    if v_category not in ('Bahan Baku', 'Bumbu', 'Rempah', 'Sayur', 'Buah', 'Lainnya')
       or v_name = '' or length(v_name) > 160 or v_unit = '' or length(v_unit) > 40
       or length(v_small_unit) > 40
       or ((v_small_unit = '') <> (v_conversion_factor is null))
       or (v_conversion_factor is not null and (v_conversion_factor <= 0 or v_conversion_factor <> trunc(v_conversion_factor)))
       or coalesce(v_line ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$'
       or coalesce(v_line ->> 'unitPrice', '') !~ '^[0-9]+$' then
      raise exception 'Nama, kategori, satuan, jumlah, atau harga item belanja tidak valid.';
    end if;
    v_quantity := (v_line ->> 'quantity')::numeric;
    v_unit_price := (v_line ->> 'unitPrice')::numeric;
    if v_quantity <= 0 or v_unit_price < 0 then raise exception 'Jumlah harus lebih dari nol dan harga tidak boleh negatif.'; end if;

    perform pg_advisory_xact_lock(hashtextextended(lower(v_name), 0));
    select * into v_item from public."modul3_stok_logistik"
    where lower(btrim("Nama Item"::text)) = lower(v_name) order by "ID" limit 1 for update;
    if not found then
      v_category_before := v_category;
      v_price_before := 0;
      v_supplier_before := '';
      if v_sequence is null then
        select coalesce(max(nullif("ID"::text, '')::bigint), 0) + 1 into v_new_id from public."modul3_stok_logistik";
      else
        loop
          execute 'select nextval($1::regclass)' into v_new_id using v_sequence;
          exit when not exists (select 1 from public."modul3_stok_logistik" where "ID"::text = v_new_id::text);
        end loop;
      end if;
      insert into public."modul3_stok_logistik" (
        "ID", "Kategori", "Nama Item", "Satuan", "Satuan Pecahan", "Faktor Konversi", "Stok", "Harga (Rp)", "Supplier"
      ) values (
        v_new_id, v_category, v_name, v_unit, v_small_unit, v_conversion_factor, 0, v_unit_price, coalesce(btrim(p_supplier), '')
      ) returning * into v_item;
    elsif lower(btrim(v_item."Satuan"::text)) <> lower(v_unit) then
      raise exception 'Satuan item "%" adalah "%"; gunakan satuan yang sama saat belanja.', v_name, v_item."Satuan";
    else
      v_category_before := coalesce(v_item."Kategori", '');
      v_price_before := nullif(v_item."Harga (Rp)"::text, '')::numeric;
      v_supplier_before := coalesce(v_item."Supplier", '');
    end if;

    v_before := coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric;
    v_after := v_before + v_quantity;
    update public."modul3_stok_logistik"
    set "Kategori" = v_category,
        "Satuan Pecahan" = case when v_small_unit <> '' then v_small_unit else "Satuan Pecahan" end,
        "Faktor Konversi" = case when v_small_unit <> '' then v_conversion_factor else "Faktor Konversi" end,
        "Stok" = v_after,
        "Harga (Rp)" = v_unit_price,
        "Supplier" = case when nullif(btrim(p_supplier), '') is not null then btrim(p_supplier) else "Supplier" end
    where "ID" = v_item."ID" returning * into v_item;

    insert into public."modul3_stok_logistik_transaksi" (
      "Tipe", "Item ID", "Kategori", "Nama Item", "Satuan", "Satuan Pecahan", "Faktor Konversi", "Jumlah Utama", "Jumlah Pecahan", "Jumlah",
      "Stok Sebelum", "Stok Sesudah", "Harga Satuan", "Supplier", "Catatan", "Tanggal", "Hari", "Lokasi", "Foto Path", "Dibuat Oleh", "ID Belanja",
      "Kategori Sebelum", "Harga Sebelum", "Supplier Sebelum"
    ) values (
      'Masuk', v_item."ID"::text, v_category, v_name, v_unit, v_small_unit, v_conversion_factor, v_quantity, 0, v_quantity,
      v_before, v_after, v_unit_price, coalesce(btrim(p_supplier), ''), coalesce(btrim(p_note), ''), v_timestamp, v_weekday,
      btrim(p_location), p_photo_path, auth.uid(), v_report."ID", v_category_before, v_price_before, v_supplier_before
    ) returning * into v_movement;

    v_total := v_total + (v_quantity * v_unit_price);
    v_item_count := v_item_count + 1;
    v_movement_ids := v_movement_ids || jsonb_build_array(v_movement."ID");
  end loop;
  update public."modul3_stok_logistik_belanja_harian" set "Total Belanja" = v_total
  where "ID" = v_report."ID" returning * into v_report;
  return jsonb_build_object('report', to_jsonb(v_report), 'movementIds', v_movement_ids, 'itemCount', v_item_count);
end;
$_$;


--
-- Name: record_stok_logistik_kitchen_usage(uuid, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_stok_logistik_kitchen_usage(p_movement_id uuid, p_used_primary_quantity numeric, p_used_small_quantity numeric, p_note text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_movement public."modul3_stok_logistik_transaksi"%rowtype;
  v_usage public."modul3_stok_logistik_pemakaian_harian"%rowtype;
  v_date date;
  v_used_quantity numeric;
  v_remainder numeric;
  v_small_unit text;
  v_conversion_factor numeric;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') not in ('admin', 'module') then
    raise exception 'Login Koki/Persiapan diperlukan untuk mencatat pemakaian harian.';
  end if;
  if p_movement_id is null or p_used_primary_quantity is null or p_used_primary_quantity < 0
     or p_used_primary_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_used_small_quantity is null or p_used_small_quantity < 0
     or p_used_small_quantity::text in ('NaN', 'Infinity', '-Infinity') or length(coalesce(p_note, '')) > 500 then
    raise exception 'Data pemakaian harian tidak valid.';
  end if;
  select * into v_movement from public."modul3_stok_logistik_transaksi"
  where "ID" = p_movement_id and "Tipe" = 'Keluar' for update;
  if not found then raise exception 'Transaksi stok keluar gudang tidak ditemukan.'; end if;
  if v_movement."Status" <> 'Aktif' then raise exception 'Transaksi stok keluar sudah dibatalkan.'; end if;

  v_small_unit := coalesce(v_movement."Satuan Pecahan", '');
  v_conversion_factor := nullif(v_movement."Faktor Konversi"::text, '')::numeric;
  if p_used_small_quantity > 0 and (v_small_unit = '' or v_conversion_factor is null or v_conversion_factor <= 0) then
    raise exception 'Pemakaian pecahan tidak memiliki faktor konversi yang valid.';
  end if;
  v_used_quantity := p_used_primary_quantity + case when p_used_small_quantity > 0 then p_used_small_quantity / v_conversion_factor else 0 end;
  if v_used_quantity > v_movement."Jumlah" then raise exception 'Jumlah dipakai tidak boleh melebihi jumlah stok yang dikeluarkan.'; end if;

  select * into v_usage from public."modul3_stok_logistik_pemakaian_harian"
  where "Transaksi Keluar ID" = v_movement."ID" for update;
  if found and v_usage."Dikembalikan Pada" is not null then
    raise exception 'Pemakaian tidak dapat diubah setelah sisa dikembalikan ke gudang.';
  end if;
  v_date := (v_movement."Tanggal" at time zone 'Asia/Jakarta')::date;
  v_remainder := v_movement."Jumlah" - v_used_quantity;
  insert into public."modul3_stok_logistik_pemakaian_harian" (
    "Transaksi Keluar ID", "Item ID", "Tanggal", "Hari", "Jumlah Keluar", "Jumlah Dipakai",
    "Jumlah Dipakai Utama", "Jumlah Dipakai Pecahan", "Satuan Pecahan", "Faktor Konversi",
    "Sisa Dapur", "Catatan", "Diperbarui Pada", "Diperbarui Oleh"
  ) values (
    v_movement."ID", v_movement."Item ID", v_date, v_movement."Hari", v_movement."Jumlah", v_used_quantity,
    p_used_primary_quantity, p_used_small_quantity, v_small_unit, v_conversion_factor,
    v_remainder, coalesce(btrim(p_note), ''), clock_timestamp(), auth.uid()
  ) on conflict ("Transaksi Keluar ID") do update set
    "Item ID" = excluded."Item ID", "Tanggal" = excluded."Tanggal", "Hari" = excluded."Hari",
    "Jumlah Keluar" = excluded."Jumlah Keluar", "Jumlah Dipakai" = excluded."Jumlah Dipakai",
    "Jumlah Dipakai Utama" = excluded."Jumlah Dipakai Utama", "Jumlah Dipakai Pecahan" = excluded."Jumlah Dipakai Pecahan",
    "Satuan Pecahan" = excluded."Satuan Pecahan", "Faktor Konversi" = excluded."Faktor Konversi",
    "Sisa Dapur" = excluded."Sisa Dapur", "Catatan" = excluded."Catatan",
    "Diperbarui Pada" = excluded."Diperbarui Pada", "Diperbarui Oleh" = excluded."Diperbarui Oleh"
  returning * into v_usage;
  return jsonb_build_object('usage', to_jsonb(v_usage));
end;
$$;


--
-- Name: record_stok_logistik_movement(text, text, numeric, numeric, text, text, text, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_stok_logistik_movement(p_item_id text, p_type text, p_quantity numeric, p_unit_price numeric, p_supplier text, p_note text, p_weekday text, p_location text, p_photo_path text, p_small_quantity numeric DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_item public."modul3_stok_logistik"%rowtype;
  v_movement public."modul3_stok_logistik_transaksi"%rowtype;
  v_before numeric;
  v_after numeric;
  v_quantity numeric;
  v_small_unit text;
  v_conversion_factor numeric;
  v_weekday text;
  v_timestamp timestamptz := clock_timestamp();
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat mencatat stok masuk atau stok keluar gudang.';
  end if;
  if nullif(btrim(p_item_id), '') is null
     or p_type is null or p_type not in ('Masuk', 'Keluar')
     or p_quantity is null or p_quantity < 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_small_quantity is null or p_small_quantity < 0 or p_small_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_weekday is null or p_weekday not in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat')
     or nullif(btrim(p_location), '') is null or length(p_location) > 300
     or length(coalesce(p_supplier, '')) > 160 or length(coalesce(p_note, '')) > 500
     or p_photo_path is null
     or p_photo_path !~ '^spas1/stok-logistik/[0-9]{4}/[0-9]{2}/[0-9]{2}-[A-Za-z]+/[^/]+\.(jpeg|png|webp)$'
     or (p_unit_price is not null and (p_unit_price < 0 or p_unit_price::text in ('NaN', 'Infinity', '-Infinity'))) then
    raise exception 'Data transaksi stok tidak valid.';
  end if;

  v_weekday := case extract(isodow from (v_timestamp at time zone 'Asia/Jakarta'))
    when 1 then 'Senin' when 2 then 'Selasa' when 3 then 'Rabu'
    when 4 then 'Kamis' when 5 then 'Jumat' when 6 then 'Sabtu' else 'Minggu'
  end;
  if v_weekday not in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat') then
    raise exception 'Transaksi operasional hanya dapat dicatat pada hari Senin–Jumat.';
  end if;

  select * into v_item from public."modul3_stok_logistik"
  where "ID"::text = p_item_id for update;
  if not found then raise exception 'Item stok tidak ditemukan.'; end if;

  v_small_unit := coalesce(v_item."Satuan Pecahan", '');
  v_conversion_factor := nullif(v_item."Faktor Konversi"::text, '')::numeric;
  if (p_quantity = 0 and p_small_quantity = 0)
     or (p_small_quantity > 0 and (v_small_unit = '' or v_conversion_factor is null or v_conversion_factor <= 0)) then
    raise exception 'Jumlah stok utama dan pecahan tidak sesuai konversi item.';
  end if;
  v_quantity := p_quantity + case when p_small_quantity > 0 then p_small_quantity / v_conversion_factor else 0 end;
  if v_quantity <= 0 then raise exception 'Jumlah stok keluar harus lebih dari nol.'; end if;

  v_before := coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric;
  v_after := case when p_type = 'Masuk' then v_before + v_quantity else v_before - v_quantity end;
  if v_after < 0 then raise exception 'Stok keluar melebihi sisa stok gudang.'; end if;
  update public."modul3_stok_logistik" set
    "Stok" = v_after,
    "Harga (Rp)" = case when p_type = 'Masuk' and p_unit_price is not null then p_unit_price else "Harga (Rp)" end
  where "ID" = v_item."ID" returning * into v_item;

  insert into public."modul3_stok_logistik_transaksi" (
    "Tipe", "Item ID", "Kategori", "Nama Item", "Satuan", "Satuan Pecahan", "Faktor Konversi",
    "Jumlah Utama", "Jumlah Pecahan", "Jumlah", "Stok Sebelum", "Stok Sesudah", "Harga Satuan",
    "Supplier", "Catatan", "Tanggal", "Hari", "Lokasi", "Foto Path", "Dibuat Oleh"
  ) values (
    p_type, p_item_id, coalesce(v_item."Kategori", ''), coalesce(v_item."Nama Item", ''),
    coalesce(v_item."Satuan", ''), v_small_unit, v_conversion_factor, p_quantity, p_small_quantity,
    v_quantity, v_before, v_after, p_unit_price, coalesce(btrim(p_supplier), ''), coalesce(btrim(p_note), ''),
    v_timestamp, v_weekday, btrim(p_location), p_photo_path, auth.uid()
  ) returning * into v_movement;
  return jsonb_build_object('movement', to_jsonb(v_movement), 'stock', to_jsonb(v_item));
end;
$_$;


--
-- Name: return_stok_logistik_kitchen_remainder(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.return_stok_logistik_kitchen_remainder(p_movement_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_usage public."modul3_stok_logistik_pemakaian_harian"%rowtype;
  v_source public."modul3_stok_logistik_transaksi"%rowtype;
  v_return public."modul3_stok_logistik_transaksi"%rowtype;
  v_item public."modul3_stok_logistik"%rowtype;
  v_remainder numeric;
  v_before numeric;
  v_after numeric;
  v_weekday text;
  v_timestamp timestamptz := clock_timestamp();
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat mengembalikan sisa ke gudang.';
  end if;
  if p_movement_id is null then raise exception 'Transaksi stok keluar tidak valid.'; end if;
  select * into v_source from public."modul3_stok_logistik_transaksi"
  where "ID" = p_movement_id and "Tipe" = 'Keluar' for update;
  if not found or v_source."Status" <> 'Aktif' then
    raise exception 'Transaksi stok keluar tidak ditemukan atau sudah dibatalkan.';
  end if;
  select * into v_usage from public."modul3_stok_logistik_pemakaian_harian"
  where "Transaksi Keluar ID" = p_movement_id and "Status" = 'Aktif' for update;
  if not found then raise exception 'Simpan jumlah pemakaian harian sebelum mengembalikan sisa.'; end if;
  if v_usage."Dikembalikan Pada" is not null or v_usage."Sisa Dapur" <= 0 then
    raise exception 'Tidak ada sisa dapur yang dapat dikembalikan atau sisa sudah pernah dikembalikan.';
  end if;
  v_weekday := case extract(isodow from (v_timestamp at time zone 'Asia/Jakarta'))
    when 1 then 'Senin' when 2 then 'Selasa' when 3 then 'Rabu'
    when 4 then 'Kamis' when 5 then 'Jumat' when 6 then 'Sabtu' else 'Minggu'
  end;
  if v_weekday not in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat') then
    raise exception 'Pengembalian stok operasional hanya dapat dicatat pada hari Senin–Jumat.';
  end if;
  select * into v_item from public."modul3_stok_logistik"
  where "ID"::text = v_source."Item ID" for update;
  if not found then raise exception 'Item stok untuk sisa dapur tidak ditemukan.'; end if;
  v_remainder := v_usage."Sisa Dapur";
  v_before := coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric;
  v_after := v_before + v_remainder;
  update public."modul3_stok_logistik" set "Stok" = v_after
  where "ID" = v_item."ID" returning * into v_item;
  insert into public."modul3_stok_logistik_transaksi" (
    "Tipe", "Item ID", "Kategori", "Nama Item", "Satuan", "Satuan Pecahan", "Faktor Konversi",
    "Jumlah Utama", "Jumlah Pecahan", "Jumlah", "Stok Sebelum", "Stok Sesudah", "Harga Satuan",
    "Supplier", "Catatan", "Tanggal", "Hari", "Lokasi", "Foto Path", "Transaksi Referensi ID", "Dibuat Oleh"
  ) values (
    'Masuk', v_item."ID"::text, coalesce(v_item."Kategori", ''), coalesce(v_item."Nama Item", ''),
    coalesce(v_item."Satuan", ''), coalesce(v_source."Satuan Pecahan", ''), v_source."Faktor Konversi",
    v_remainder, 0, v_remainder, v_before, v_after, nullif(v_item."Harga (Rp)"::text, '')::numeric,
    coalesce(v_item."Supplier", ''), 'Pengembalian sisa pemakaian dari transaksi ' || p_movement_id::text,
    v_timestamp, v_weekday, v_source."Lokasi", v_source."Foto Path", v_source."ID", auth.uid()
  ) returning * into v_return;
  update public."modul3_stok_logistik_pemakaian_harian"
  set "Jumlah Dikembalikan" = v_remainder, "Dikembalikan Pada" = v_timestamp,
      "Transaksi Pengembalian ID" = v_return."ID", "Diperbarui Pada" = v_timestamp, "Diperbarui Oleh" = auth.uid()
  where "ID" = v_usage."ID" returning * into v_usage;
  return jsonb_build_object('usage', to_jsonb(v_usage), 'returnMovement', to_jsonb(v_return), 'stock', to_jsonb(v_item));
end;
$$;


--
-- Name: void_stok_logistik_transaction(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.void_stok_logistik_transaction(p_movement_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_selected public."modul3_stok_logistik_transaksi"%rowtype;
  v_report public."modul3_stok_logistik_belanja_harian"%rowtype;
  v_movement public."modul3_stok_logistik_transaksi"%rowtype;
  v_item public."modul3_stok_logistik"%rowtype;
  v_latest public."modul3_stok_logistik_transaksi"%rowtype;
  v_snapshot public."modul3_stok_logistik_transaksi"%rowtype;
  v_report_id uuid;
  v_item_id text;
  v_before numeric;
  v_after numeric;
  v_stock_type text;
  v_timestamp timestamptz := clock_timestamp();
  v_adjustments jsonb := '[]'::jsonb;
  v_metadata_restored boolean := true;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat membatalkan transaksi stok.';
  end if;
  if p_movement_id is null
     or nullif(btrim(p_reason), '') is null
     or length(btrim(p_reason)) < 5
     or length(p_reason) > 500 then
    raise exception 'ID transaksi dan alasan pembatalan minimal 5 karakter wajib diisi.';
  end if;

  select * into v_selected
  from public."modul3_stok_logistik_transaksi"
  where "ID" = p_movement_id;
  if not found then
    raise exception 'Transaksi stok tidak ditemukan.';
  end if;

  v_report_id := v_selected."ID Belanja";
  if v_report_id is not null then
    select * into v_report
    from public."modul3_stok_logistik_belanja_harian"
    where "ID" = v_report_id
    for update;
    if not found then
      raise exception 'Laporan nota pembelian tidak ditemukan; pembatalan dihentikan.';
    end if;
    if v_report."Status" <> 'Aktif' then
      raise exception 'Nota pembelian ini sudah dibatalkan.';
    end if;
    perform 1
    from public."modul3_stok_logistik_transaksi"
    where "ID Belanja" = v_report_id
    order by "Item ID", "ID"
    for update;
  else
    select * into v_selected
    from public."modul3_stok_logistik_transaksi"
    where "ID" = p_movement_id
    for update;
    if not found then
      raise exception 'Transaksi stok tidak ditemukan.';
    end if;
    if v_selected."Status" <> 'Aktif' then
      raise exception 'Transaksi stok ini sudah dibatalkan.';
    end if;
  end if;

  perform 1
  from public."modul3_stok_logistik" s
  where s."ID"::text in (
    select t."Item ID"
    from public."modul3_stok_logistik_transaksi" t
    where (v_report_id is not null and t."ID Belanja" = v_report_id)
       or (v_report_id is null and t."ID" = p_movement_id)
  )
  order by s."ID"
  for update;

  select data_type into v_stock_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'modul3_stok_logistik'
    and column_name = 'Stok';

  for v_movement in
    select *
    from public."modul3_stok_logistik_transaksi"
    where (v_report_id is not null and "ID Belanja" = v_report_id)
       or (v_report_id is null and "ID" = p_movement_id)
    order by "Item ID", "ID"
    for update
  loop
    if v_movement."Status" <> 'Aktif' then
      raise exception 'Semua baris nota harus masih aktif agar pembatalan dapat dilakukan.';
    end if;

    select * into v_item
    from public."modul3_stok_logistik"
    where "ID"::text = v_movement."Item ID"
    for update;
    if not found then
      raise exception 'Item "%" sudah tidak ada di stok gudang; pembatalan dihentikan.', v_movement."Nama Item";
    end if;

    v_before := coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric;
    v_after := case
      when v_movement."Tipe" = 'Masuk' then v_before - v_movement."Jumlah"
      else v_before + v_movement."Jumlah"
    end;
    if v_after < 0 then
      raise exception 'Pembatalan pembelian "%" ditolak: stok tersedia % %, sedangkan % % harus dikurangi.',
        v_movement."Nama Item", v_before, v_movement."Satuan",
        v_movement."Jumlah", v_movement."Satuan";
    end if;
    if v_stock_type in ('smallint', 'integer', 'bigint') and v_after <> trunc(v_after) then
      raise exception 'Kolom stok item "%" hanya mendukung bilangan bulat; pembatalan dihentikan.',
        v_movement."Nama Item";
    end if;

    update public."modul3_stok_logistik"
    set "Stok" = v_after
    where "ID" = v_item."ID";

    update public."modul3_stok_logistik_transaksi"
    set "Status" = 'Dibatalkan',
        "Dibatalkan Pada" = v_timestamp,
        "Dibatalkan Oleh" = auth.uid(),
        "Alasan Pembatalan" = btrim(p_reason),
        "Stok Sebelum Pembatalan" = v_before,
        "Stok Sesudah Pembatalan" = v_after
    where "ID" = v_movement."ID";

    update public."modul3_stok_logistik_pemakaian_harian"
    set "Status" = 'Dibatalkan',
        "Dibatalkan Pada" = v_timestamp,
        "Dibatalkan Oleh" = auth.uid(),
        "Alasan Pembatalan" = btrim(p_reason)
    where "Transaksi Keluar ID" = v_movement."ID"
      and "Status" = 'Aktif';

    v_adjustments := v_adjustments || jsonb_build_array(jsonb_build_object(
      'movementId', v_movement."ID",
      'itemId', v_movement."Item ID",
      'itemName', v_movement."Nama Item",
      'type', v_movement."Tipe",
      'quantity', v_movement."Jumlah",
      'stockBeforeCancellation', v_before,
      'stockAfterCancellation', v_after
    ));
  end loop;

  if v_report_id is not null then
    update public."modul3_stok_logistik_belanja_harian"
    set "Status" = 'Dibatalkan',
        "Dibatalkan Pada" = v_timestamp,
        "Dibatalkan Oleh" = auth.uid(),
        "Alasan Pembatalan" = btrim(p_reason)
    where "ID" = v_report_id;
  end if;

  for v_item_id in
    select distinct t."Item ID"
    from public."modul3_stok_logistik_transaksi" t
    where (v_report_id is not null and t."ID Belanja" = v_report_id)
       or (v_report_id is null and t."ID" = p_movement_id)
  loop
    if exists (
      select 1
      from public."modul3_stok_logistik_transaksi" t
      where t."Item ID" = v_item_id
        and ((v_report_id is not null and t."ID Belanja" = v_report_id)
          or (v_report_id is null and t."ID" = p_movement_id))
        and t."Tipe" = 'Masuk'
    ) then
      select * into v_latest
      from public."modul3_stok_logistik_transaksi" t
      where t."Item ID" = v_item_id
        and t."Tipe" = 'Masuk'
        and t."Status" = 'Aktif'
        and t."Tanggal" > (
          select max(cancelled."Tanggal")
          from public."modul3_stok_logistik_transaksi" cancelled
          where cancelled."Item ID" = v_item_id
            and ((v_report_id is not null and cancelled."ID Belanja" = v_report_id)
              or (v_report_id is null and cancelled."ID" = p_movement_id))
        )
      order by t."Tanggal" desc, t."ID" desc
      limit 1;

      if found then
        update public."modul3_stok_logistik"
        set "Kategori" = v_latest."Kategori",
            "Harga (Rp)" = coalesce(v_latest."Harga Satuan", "Harga (Rp)"),
            "Supplier" = coalesce(v_latest."Supplier", '')
        where "ID"::text = v_item_id;
      else
        select * into v_snapshot
        from public."modul3_stok_logistik_transaksi" t
        where t."Item ID" = v_item_id
          and ((v_report_id is not null and t."ID Belanja" = v_report_id)
            or (v_report_id is null and t."ID" = p_movement_id))
          and t."Tipe" = 'Masuk'
        order by t."Stok Sebelum", t."ID"
        limit 1;
        if v_snapshot."Kategori Sebelum" is null
           and v_snapshot."Harga Sebelum" is null
           and v_snapshot."Supplier Sebelum" is null then
          v_metadata_restored := false;
        else
          update public."modul3_stok_logistik"
          set "Kategori" = coalesce(v_snapshot."Kategori Sebelum", "Kategori"),
              "Harga (Rp)" = coalesce(v_snapshot."Harga Sebelum", "Harga (Rp)"),
              "Supplier" = coalesce(v_snapshot."Supplier Sebelum", "Supplier")
          where "ID"::text = v_item_id;
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'success',
    'reportId', v_report_id,
    'reason', btrim(p_reason),
    'cancelledAt', v_timestamp,
    'adjustments', v_adjustments,
    'metadataRestored', v_metadata_restored
  );
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ADMIN_Login; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ADMIN_Login" (
    "Username" text,
    "Password Salt" text,
    "Password Hash" text,
    "Role" text,
    "Status" text,
    "Last Login" text
);


--
-- Name: TABLE "ADMIN_Login"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."ADMIN_Login" IS 'super admin login';


--
-- Name: INFO_SPPG; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."INFO_SPPG" (
    "ID" text,
    "Tanggal" text,
    "Kategori" text,
    "Judul" text,
    "Isi" text,
    "Status" text,
    "Dibuat" text,
    "Poster File ID" text,
    "Poster URL" text
);

ALTER TABLE ONLY public."INFO_SPPG" REPLICA IDENTITY FULL;


--
-- Name: TABLE "INFO_SPPG"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."INFO_SPPG" IS 'informasi SPPG Sungai Pasir 1';


--
-- Name: MODUL1_Absensi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL1_Absensi" (
    "Timestamp" text NOT NULL,
    "ID Karyawan" text NOT NULL,
    "Nama" text NOT NULL,
    "Divisi" text NOT NULL,
    "Tipe Absen" text NOT NULL,
    "Jam" text NOT NULL,
    "Lokasi" text NOT NULL,
    "Status Face" text NOT NULL,
    "ID Absensi" uuid DEFAULT gen_random_uuid() NOT NULL
);

ALTER TABLE ONLY public."MODUL1_Absensi" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL1_Absensi"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL1_Absensi" IS 'Absensi Harian Relawan';


--
-- Name: MODUL1_Absensi_Drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL1_Absensi_Drafts" (
    "ID Absensi" uuid NOT NULL,
    "Data" jsonb NOT NULL,
    "Diperbarui" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: MODUL1_DataRelawan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL1_DataRelawan" (
    "ID Relawan" text,
    "Nama Lengkap" text,
    "Divisi" text,
    "Role" text,
    "Status Biometrik" text,
    "No HP" text,
    "Foto URL" text,
    "Auth User ID" uuid,
    "Status Akun" text
);

ALTER TABLE ONLY public."MODUL1_DataRelawan" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL1_DataRelawan"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL1_DataRelawan" IS 'data relawan absensi';


--
-- Name: MODUL1_PendaftaranRelawan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL1_PendaftaranRelawan" (
    "ID Permohonan" text,
    "Nama Lengkap" text,
    "Email" text,
    "No HP" text,
    "Status" text,
    "Diajukan Pada" text,
    "Diputuskan Pada" text,
    "Diputuskan Oleh" text,
    "ID Relawan" text,
    "PIN Salt" text,
    "PIN Hash" text,
    "Auth User ID" uuid,
    "Role" text,
    "Divisi" text
);

ALTER TABLE ONLY public."MODUL1_PendaftaranRelawan" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL1_PendaftaranRelawan"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL1_PendaftaranRelawan" IS 'Form Permohonan Registrasi relawan';


--
-- Name: MODUL4_AnggaranPO; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_AnggaranPO" (
    "Hari" text,
    "Kategori" text,
    "Nama Bahan" text,
    "Gramasi / Porsi Besar" text,
    "Gramasi / Porsi Kecil" text,
    "Total Kebutuhan Besar" text,
    "Total Kebutuhan Kecil" text,
    "Satuan" text,
    "Harga Satuan (Rp)" text,
    "Satuan Harga" text,
    "Total Anggaran Besar (Rp)" text,
    "Total Anggaran Kecil (Rp)" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_AnggaranPO" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_AnggaranPO"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_AnggaranPO" IS 'anggaran po bumbu dan bahan baku';


--
-- Name: MODUL4_CloudSync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_CloudSync" (
    "Timestamp" text,
    "Status" text,
    "Module" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_CloudSync" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_CloudSync"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_CloudSync" IS 'cloudsync';


--
-- Name: MODUL4_HACCP; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_HACCP" (
    "Cold Storage" text,
    "Organoleptik" text,
    "Sanitasi" text,
    "Labeling" text,
    "Tanggal" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_HACCP" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_HACCP"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_HACCP" IS 'HACCP';


--
-- Name: MODUL4_JadwalDistribusi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_JadwalDistribusi" (
    "Hari" text,
    "Jam Distribusi" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_JadwalDistribusi" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_JadwalDistribusi"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_JadwalDistribusi" IS 'jadwal distribusi';


--
-- Name: MODUL4_Joblist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_Joblist" (
    "ID" bigint,
    "Judul" text,
    "Hari" text,
    "Kategori" text,
    "Prioritas" text,
    "PJ" text,
    "Status" text,
    "Shift" text,
    "Jam Target" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_Joblist" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_Joblist"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_Joblist" IS 'Tugas Tim persiapan';


--
-- Name: MODUL4_PosterAKG; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_PosterAKG" (
    "ID" text,
    "Judul" text,
    "Tanggal" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_PosterAKG" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_PosterAKG"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_PosterAKG" IS 'poster AKG';


--
-- Name: MODUL4_Resep; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_Resep" (
    "Hari" text,
    "Menu List" text,
    "Detail Resep" text,
    "Jam Kirim" text,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_Resep" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_Resep"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_Resep" IS 'standar resep';


--
-- Name: MODUL4_TargetPorsi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MODUL4_TargetPorsi" (
    "Tanggal" text,
    "Target Porsi" bigint,
    "Porsi Besar" bigint,
    "Porsi Kecil" bigint,
    "AppKey" text,
    "Data" jsonb
);

ALTER TABLE ONLY public."MODUL4_TargetPorsi" REPLICA IDENTITY FULL;


--
-- Name: TABLE "MODUL4_TargetPorsi"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."MODUL4_TargetPorsi" IS 'target porsi global';


--
-- Name: SPAS1_BENEFICIARIES; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SPAS1_BENEFICIARIES" (
    "ID" text,
    "Kategori" text,
    "Nama Satuan" text,
    "Jumlah" text,
    "Catatan" text,
    "Diperbarui" text
);


--
-- Name: TABLE "SPAS1_BENEFICIARIES"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."SPAS1_BENEFICIARIES" IS 'SPAS1 BENEFICIARIES';


--
-- Name: SPAS1_MEDIA; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SPAS1_MEDIA" (
    "ID" text,
    "Tanggal" text,
    "Kategori" text,
    "Judul" text,
    "Deskripsi" text,
    "File ID" text,
    "URL" text,
    "Status" text,
    "Tampil di Beranda" text,
    "Dibuat" text
);

ALTER TABLE ONLY public."SPAS1_MEDIA" REPLICA IDENTITY FULL;


--
-- Name: TABLE "SPAS1_MEDIA"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."SPAS1_MEDIA" IS 'Info Media Database SPAS1';


--
-- Name: SPAS1_SETTINGS; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SPAS1_SETTINGS" (
    "Pengaturan" text,
    "Nilai" text,
    "Diperbarui" text
);

ALTER TABLE ONLY public."SPAS1_SETTINGS" REPLICA IDENTITY FULL;


--
-- Name: TABLE "SPAS1_SETTINGS"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."SPAS1_SETTINGS" IS 'seting super admin';


--
-- Name: SPAS1_TEAM; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SPAS1_TEAM" (
    "ID" text,
    "Jabatan" text,
    "Nama" text,
    "Tugas" text,
    "Foto File ID" text,
    "Foto URL" text,
    "Publikasi Disetujui" text,
    "Urutan" bigint,
    "Diperbarui" text
);


--
-- Name: TABLE "SPAS1_TEAM"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."SPAS1_TEAM" IS 'struktur SPAS1';


--
-- Name: aboutsky_archive_access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_archive_access_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_user_id uuid,
    folder_id smallint,
    result text NOT NULL,
    CONSTRAINT aboutsky_archive_access_logs_result_check CHECK ((result = ANY (ARRAY['granted'::text, 'denied'::text])))
);


--
-- Name: aboutsky_archive_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_archive_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id smallint NOT NULL,
    name text NOT NULL,
    file_type text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    file_size bigint NOT NULL,
    storage_path text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT aboutsky_archive_files_description_check CHECK ((length(description) <= 500)),
    CONSTRAINT aboutsky_archive_files_file_size_check CHECK (((file_size >= 0) AND (file_size <= 104857600))),
    CONSTRAINT aboutsky_archive_files_file_type_check CHECK ((file_type = ANY (ARRAY['pdf'::text, 'doc'::text, 'img'::text, 'zip'::text, 'sql'::text, 'csv'::text]))),
    CONSTRAINT aboutsky_archive_files_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 255)))
);


--
-- Name: aboutsky_archive_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_archive_folders (
    id smallint NOT NULL,
    title text NOT NULL,
    icon text NOT NULL,
    CONSTRAINT aboutsky_archive_folders_icon_check CHECK ((icon ~ '^fa-[a-z0-9-]+$'::text)),
    CONSTRAINT aboutsky_archive_folders_id_check CHECK (((id >= 1) AND (id <= 7)))
);


--
-- Name: aboutsky_contact_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_contact_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    subject text NOT NULL,
    message text NOT NULL,
    CONSTRAINT aboutsky_contact_messages_email_check CHECK (((length(email) >= 3) AND (length(email) <= 254))),
    CONSTRAINT aboutsky_contact_messages_message_check CHECK (((length(btrim(message)) >= 1) AND (length(btrim(message)) <= 5000))),
    CONSTRAINT aboutsky_contact_messages_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 150))),
    CONSTRAINT aboutsky_contact_messages_subject_check CHECK (((length(btrim(subject)) >= 1) AND (length(btrim(subject)) <= 200)))
);


--
-- Name: aboutsky_contact_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_contact_rate_limits (
    ip_hash text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    CONSTRAINT aboutsky_contact_rate_limits_ip_hash_check CHECK ((ip_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT aboutsky_contact_rate_limits_request_count_check CHECK (((request_count >= 1) AND (request_count <= 6)))
);


--
-- Name: aboutsky_public_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aboutsky_public_content (
    content_key text NOT NULL,
    payload jsonb NOT NULL,
    published boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT aboutsky_public_content_content_key_check CHECK ((content_key ~ '^[a-z][a-z0-9_-]{0,49}$'::text)),
    CONSTRAINT aboutsky_public_content_payload_check CHECK ((jsonb_typeof(payload) = ANY (ARRAY['array'::text, 'object'::text])))
);


--
-- Name: modul2_bank_menu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul2_bank_menu (
    "ID" bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    "Nama Menu" text,
    "Hari" text,
    "Kategori" text,
    "Daerah" text,
    "Karbohidrat" text,
    "Protein Hewani" text,
    "Protein Nabati" text,
    "Sayuran" text,
    "Buah" text,
    "Kalori" double precision,
    "Protein" double precision,
    "Lemak" double precision,
    "AKG Data" jsonb
);


--
-- Name: TABLE modul2_bank_menu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.modul2_bank_menu IS 'Data 500 paket menu standar dan nilai gizi MBG';


--
-- Name: modul2_bank_menu_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.modul2_bank_menu ALTER COLUMN "ID" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.modul2_bank_menu_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: modul2_bank_menu_period; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul2_bank_menu_period (
    "ID" text NOT NULL,
    "Periode Bulan" text NOT NULL,
    "Periode Minggu" smallint NOT NULL,
    "Kategori" text NOT NULL,
    "Menu ID" bigint NOT NULL,
    "Data Menu" jsonb NOT NULL,
    "Periode Hari" text DEFAULT 'Senin'::text NOT NULL,
    CONSTRAINT "modul2_bank_menu_period_Periode Bulan_check" CHECK (("Periode Bulan" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT "modul2_bank_menu_period_Periode Minggu_check" CHECK ((("Periode Minggu" >= 1) AND ("Periode Minggu" <= 4))),
    CONSTRAINT modul2_bank_menu_period_day_check CHECK (("Periode Hari" = ANY (ARRAY['Senin'::text, 'Selasa'::text, 'Rabu'::text, 'Kamis'::text, 'Jumat'::text])))
);


--
-- Name: modul3_stok_logistik; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul3_stok_logistik (
    "ID" bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    "Kategori" text,
    "Nama Item" text,
    "Satuan" text,
    "Stok" numeric,
    "Harga (Rp)" bigint,
    "Supplier" text,
    "Satuan Pecahan" text DEFAULT ''::text NOT NULL,
    "Faktor Konversi" numeric,
    CONSTRAINT modul3_stok_logistik_conversion_check CHECK (((("Satuan Pecahan" = ''::text) AND ("Faktor Konversi" IS NULL)) OR (((length("Satuan Pecahan") >= 1) AND (length("Satuan Pecahan") <= 40)) AND ("Faktor Konversi" IS NOT NULL) AND ("Faktor Konversi" > (0)::numeric) AND ("Faktor Konversi" = trunc("Faktor Konversi")))))
);


--
-- Name: TABLE modul3_stok_logistik; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.modul3_stok_logistik IS 'Data stok logistik dapur';


--
-- Name: modul3_stok_logistik_belanja_harian; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul3_stok_logistik_belanja_harian (
    "ID" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Tanggal" timestamp with time zone DEFAULT now() NOT NULL,
    "Hari" text NOT NULL,
    "Supplier" text DEFAULT ''::text NOT NULL,
    "Catatan" text DEFAULT ''::text NOT NULL,
    "Lokasi" text NOT NULL,
    "Foto Path" text NOT NULL,
    "Total Belanja" numeric DEFAULT 0 NOT NULL,
    "Jumlah Item" integer DEFAULT 0 NOT NULL,
    "Dibuat Oleh" uuid DEFAULT auth.uid() NOT NULL,
    "Status" text DEFAULT 'Aktif'::text NOT NULL,
    "Dibatalkan Pada" timestamp with time zone,
    "Dibatalkan Oleh" uuid,
    "Alasan Pembatalan" text,
    CONSTRAINT "modul3_stok_logistik_belanja_harian_Hari_check" CHECK (("Hari" = ANY (ARRAY['Senin'::text, 'Selasa'::text, 'Rabu'::text, 'Kamis'::text, 'Jumat'::text]))),
    CONSTRAINT "modul3_stok_logistik_belanja_harian_Jumlah Item_check" CHECK (("Jumlah Item" > 0)),
    CONSTRAINT "modul3_stok_logistik_belanja_harian_Total Belanja_check" CHECK (("Total Belanja" >= (0)::numeric)),
    CONSTRAINT modul3_stok_logistik_belanja_harian_status_check CHECK (("Status" = ANY (ARRAY['Aktif'::text, 'Dibatalkan'::text])))
);


--
-- Name: modul3_stok_logistik_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik ALTER COLUMN "ID" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.modul3_stok_logistik_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: modul3_stok_logistik_kitchen_demo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul3_stok_logistik_kitchen_demo (
    "ID" text NOT NULL,
    "Tanggal" date NOT NULL,
    "Nama Folder" text NOT NULL,
    "Status" text DEFAULT 'draft'::text NOT NULL,
    "Data" jsonb NOT NULL,
    "Dibuat Pada" timestamp with time zone DEFAULT now() NOT NULL,
    "Diperbarui Pada" timestamp with time zone DEFAULT now() NOT NULL,
    "Dibuat Oleh" uuid DEFAULT auth.uid() NOT NULL,
    CONSTRAINT "modul3_stok_logistik_kitchen_demo_Data_check" CHECK ((jsonb_typeof("Data") = 'object'::text)),
    CONSTRAINT "modul3_stok_logistik_kitchen_demo_Nama Folder_check" CHECK (((length("Nama Folder") >= 1) AND (length("Nama Folder") <= 160))),
    CONSTRAINT "modul3_stok_logistik_kitchen_demo_Status_check" CHECK (("Status" = ANY (ARRAY['draft'::text, 'saved'::text, 'returned'::text])))
);


--
-- Name: modul3_stok_logistik_pemakaian_harian; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul3_stok_logistik_pemakaian_harian (
    "ID" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Transaksi Keluar ID" uuid NOT NULL,
    "Item ID" text NOT NULL,
    "Tanggal" date NOT NULL,
    "Hari" text NOT NULL,
    "Jumlah Keluar" numeric NOT NULL,
    "Jumlah Dipakai" numeric NOT NULL,
    "Sisa Dapur" numeric NOT NULL,
    "Catatan" text DEFAULT ''::text NOT NULL,
    "Diperbarui Pada" timestamp with time zone DEFAULT now() NOT NULL,
    "Diperbarui Oleh" uuid DEFAULT auth.uid() NOT NULL,
    "Status" text DEFAULT 'Aktif'::text NOT NULL,
    "Dibatalkan Pada" timestamp with time zone,
    "Dibatalkan Oleh" uuid,
    "Alasan Pembatalan" text,
    "Jumlah Dipakai Utama" numeric DEFAULT 0 NOT NULL,
    "Jumlah Dipakai Pecahan" numeric DEFAULT 0 NOT NULL,
    "Satuan Pecahan" text DEFAULT ''::text NOT NULL,
    "Faktor Konversi" numeric,
    "Jumlah Dikembalikan" numeric DEFAULT 0 NOT NULL,
    "Dikembalikan Pada" timestamp with time zone,
    "Transaksi Pengembalian ID" uuid,
    CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Hari_check" CHECK (("Hari" = ANY (ARRAY['Senin'::text, 'Selasa'::text, 'Rabu'::text, 'Kamis'::text, 'Jumat'::text]))),
    CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Jumlah Dipakai_check" CHECK (("Jumlah Dipakai" >= (0)::numeric)),
    CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Jumlah Keluar_check" CHECK (("Jumlah Keluar" > (0)::numeric)),
    CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Sisa Dapur_check" CHECK (("Sisa Dapur" >= (0)::numeric)),
    CONSTRAINT modul3_stok_logistik_pemakaian_harian_check CHECK ((("Jumlah Dipakai" + "Sisa Dapur") = "Jumlah Keluar")),
    CONSTRAINT modul3_stok_logistik_pemakaian_harian_status_check CHECK (("Status" = ANY (ARRAY['Aktif'::text, 'Dibatalkan'::text])))
);


--
-- Name: modul3_stok_logistik_transaksi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modul3_stok_logistik_transaksi (
    "ID" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Tipe" text NOT NULL,
    "Item ID" text NOT NULL,
    "Kategori" text NOT NULL,
    "Nama Item" text NOT NULL,
    "Satuan" text NOT NULL,
    "Jumlah" numeric NOT NULL,
    "Stok Sebelum" numeric NOT NULL,
    "Stok Sesudah" numeric NOT NULL,
    "Harga Satuan" numeric,
    "Supplier" text DEFAULT ''::text NOT NULL,
    "Catatan" text DEFAULT ''::text NOT NULL,
    "Tanggal" timestamp with time zone DEFAULT now() NOT NULL,
    "Hari" text NOT NULL,
    "Lokasi" text NOT NULL,
    "Foto Path" text NOT NULL,
    "Dibuat Oleh" uuid DEFAULT auth.uid() NOT NULL,
    "ID Belanja" uuid,
    "Status" text DEFAULT 'Aktif'::text NOT NULL,
    "Dibatalkan Pada" timestamp with time zone,
    "Dibatalkan Oleh" uuid,
    "Alasan Pembatalan" text,
    "Stok Sebelum Pembatalan" numeric,
    "Stok Sesudah Pembatalan" numeric,
    "Kategori Sebelum" text,
    "Harga Sebelum" numeric,
    "Supplier Sebelum" text,
    "Transaksi Referensi ID" uuid,
    "Satuan Pecahan" text DEFAULT ''::text NOT NULL,
    "Faktor Konversi" numeric,
    "Jumlah Utama" numeric DEFAULT 0 NOT NULL,
    "Jumlah Pecahan" numeric DEFAULT 0 NOT NULL,
    CONSTRAINT "modul3_stok_logistik_transaksi_Harga Satuan_check" CHECK ((("Harga Satuan" IS NULL) OR ("Harga Satuan" >= (0)::numeric))),
    CONSTRAINT "modul3_stok_logistik_transaksi_Hari_check" CHECK (("Hari" = ANY (ARRAY['Senin'::text, 'Selasa'::text, 'Rabu'::text, 'Kamis'::text, 'Jumat'::text]))),
    CONSTRAINT "modul3_stok_logistik_transaksi_Jumlah_check" CHECK (("Jumlah" > (0)::numeric)),
    CONSTRAINT "modul3_stok_logistik_transaksi_Stok Sebelum_check" CHECK (("Stok Sebelum" >= (0)::numeric)),
    CONSTRAINT "modul3_stok_logistik_transaksi_Stok Sesudah_check" CHECK (("Stok Sesudah" >= (0)::numeric)),
    CONSTRAINT "modul3_stok_logistik_transaksi_Tipe_check" CHECK (("Tipe" = ANY (ARRAY['Masuk'::text, 'Keluar'::text]))),
    CONSTRAINT modul3_stok_logistik_transaksi_status_check CHECK (("Status" = ANY (ARRAY['Aktif'::text, 'Dibatalkan'::text])))
);


--
-- Name: spas1_lpdh_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spas1_lpdh_reports (
    report_date date NOT NULL,
    sppg_name text NOT NULL,
    sppg_code text DEFAULT ''::text NOT NULL,
    fund_period text DEFAULT ''::text NOT NULL,
    beneficiary_portions integer DEFAULT 0 NOT NULL,
    accountant_name text DEFAULT ''::text NOT NULL,
    opening_cash numeric(14,2) DEFAULT 0 NOT NULL,
    top_up numeric(14,2) DEFAULT 0 NOT NULL,
    operational_cap numeric(14,2),
    expenses jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approver_name text DEFAULT ''::text NOT NULL,
    signatures jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT spas1_lpdh_reports_beneficiary_portions_check CHECK ((beneficiary_portions >= 0)),
    CONSTRAINT spas1_lpdh_reports_expenses_check CHECK ((jsonb_typeof(expenses) = 'array'::text)),
    CONSTRAINT spas1_lpdh_reports_opening_cash_check CHECK ((opening_cash >= (0)::numeric)),
    CONSTRAINT spas1_lpdh_reports_operational_cap_check CHECK (((operational_cap IS NULL) OR (operational_cap >= (0)::numeric))),
    CONSTRAINT spas1_lpdh_reports_top_up_check CHECK ((top_up >= (0)::numeric))
);


--
-- Name: spas1_lpj_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spas1_lpj_reports (
    report_date date NOT NULL,
    identity jsonb DEFAULT '{}'::jsonb NOT NULL,
    cash_book jsonb DEFAULT '[]'::jsonb NOT NULL,
    budget jsonb DEFAULT '[]'::jsonb NOT NULL,
    food_costs jsonb DEFAULT '[]'::jsonb NOT NULL,
    stock_card jsonb DEFAULT '[]'::jsonb NOT NULL,
    distribution jsonb DEFAULT '[]'::jsonb NOT NULL,
    honorarium jsonb DEFAULT '[]'::jsonb NOT NULL,
    sptjm jsonb DEFAULT '{}'::jsonb NOT NULL,
    signatures jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT spas1_lpj_reports_budget_check CHECK ((jsonb_typeof(budget) = 'array'::text)),
    CONSTRAINT spas1_lpj_reports_cash_book_check CHECK ((jsonb_typeof(cash_book) = 'array'::text)),
    CONSTRAINT spas1_lpj_reports_distribution_check CHECK ((jsonb_typeof(distribution) = 'array'::text)),
    CONSTRAINT spas1_lpj_reports_food_costs_check CHECK ((jsonb_typeof(food_costs) = 'array'::text)),
    CONSTRAINT spas1_lpj_reports_honorarium_check CHECK ((jsonb_typeof(honorarium) = 'array'::text)),
    CONSTRAINT spas1_lpj_reports_identity_check CHECK ((jsonb_typeof(identity) = 'object'::text)),
    CONSTRAINT spas1_lpj_reports_signatures_check CHECK ((jsonb_typeof(signatures) = 'object'::text)),
    CONSTRAINT spas1_lpj_reports_sptjm_check CHECK ((jsonb_typeof(sptjm) = 'object'::text)),
    CONSTRAINT spas1_lpj_reports_stock_card_check CHECK ((jsonb_typeof(stock_card) = 'array'::text))
);


--
-- Name: MODUL1_Absensi_Drafts MODUL1_Absensi_Drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MODUL1_Absensi_Drafts"
    ADD CONSTRAINT "MODUL1_Absensi_Drafts_pkey" PRIMARY KEY ("ID Absensi");


--
-- Name: aboutsky_archive_access_logs aboutsky_archive_access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_access_logs
    ADD CONSTRAINT aboutsky_archive_access_logs_pkey PRIMARY KEY (id);


--
-- Name: aboutsky_archive_files aboutsky_archive_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_files
    ADD CONSTRAINT aboutsky_archive_files_pkey PRIMARY KEY (id);


--
-- Name: aboutsky_archive_files aboutsky_archive_files_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_files
    ADD CONSTRAINT aboutsky_archive_files_storage_path_key UNIQUE (storage_path);


--
-- Name: aboutsky_archive_folders aboutsky_archive_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_folders
    ADD CONSTRAINT aboutsky_archive_folders_pkey PRIMARY KEY (id);


--
-- Name: aboutsky_contact_messages aboutsky_contact_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_contact_messages
    ADD CONSTRAINT aboutsky_contact_messages_pkey PRIMARY KEY (id);


--
-- Name: aboutsky_contact_rate_limits aboutsky_contact_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_contact_rate_limits
    ADD CONSTRAINT aboutsky_contact_rate_limits_pkey PRIMARY KEY (ip_hash);


--
-- Name: aboutsky_public_content aboutsky_public_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_public_content
    ADD CONSTRAINT aboutsky_public_content_pkey PRIMARY KEY (content_key);


--
-- Name: modul2_bank_menu_period modul2_bank_menu_period_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul2_bank_menu_period
    ADD CONSTRAINT modul2_bank_menu_period_pkey PRIMARY KEY ("ID");


--
-- Name: modul2_bank_menu modul2_bank_menu_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul2_bank_menu
    ADD CONSTRAINT modul2_bank_menu_pkey PRIMARY KEY ("ID");


--
-- Name: modul3_stok_logistik_belanja_harian modul3_stok_logistik_belanja_harian_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_belanja_harian
    ADD CONSTRAINT modul3_stok_logistik_belanja_harian_pkey PRIMARY KEY ("ID");


--
-- Name: modul3_stok_logistik_kitchen_demo modul3_stok_logistik_kitchen_demo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_kitchen_demo
    ADD CONSTRAINT modul3_stok_logistik_kitchen_demo_pkey PRIMARY KEY ("ID");


--
-- Name: modul3_stok_logistik_pemakaian_harian modul3_stok_logistik_pemakaian_harian_Transaksi Keluar ID_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_pemakaian_harian
    ADD CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Transaksi Keluar ID_key" UNIQUE ("Transaksi Keluar ID");


--
-- Name: modul3_stok_logistik_pemakaian_harian modul3_stok_logistik_pemakaian_harian_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_pemakaian_harian
    ADD CONSTRAINT modul3_stok_logistik_pemakaian_harian_pkey PRIMARY KEY ("ID");


--
-- Name: modul3_stok_logistik modul3_stok_logistik_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik
    ADD CONSTRAINT modul3_stok_logistik_pkey PRIMARY KEY ("ID");


--
-- Name: modul3_stok_logistik_transaksi modul3_stok_logistik_transaksi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_transaksi
    ADD CONSTRAINT modul3_stok_logistik_transaksi_pkey PRIMARY KEY ("ID");


--
-- Name: spas1_lpdh_reports spas1_lpdh_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spas1_lpdh_reports
    ADD CONSTRAINT spas1_lpdh_reports_pkey PRIMARY KEY (report_date);


--
-- Name: spas1_lpj_reports spas1_lpj_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spas1_lpj_reports
    ADD CONSTRAINT spas1_lpj_reports_pkey PRIMARY KEY (report_date);


--
-- Name: MODUL1_Absensi_ID_Absensi_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL1_Absensi_ID_Absensi_app_key" ON public."MODUL1_Absensi" USING btree ("ID Absensi");


--
-- Name: MODUL1_DataRelawan_Auth_User_ID_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL1_DataRelawan_Auth_User_ID_app_key" ON public."MODUL1_DataRelawan" USING btree ("Auth User ID");


--
-- Name: MODUL1_DataRelawan_ID_Relawan_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL1_DataRelawan_ID_Relawan_app_key" ON public."MODUL1_DataRelawan" USING btree ("ID Relawan");


--
-- Name: MODUL1_PendaftaranRelawan_ID_Permohonan_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL1_PendaftaranRelawan_ID_Permohonan_app_key" ON public."MODUL1_PendaftaranRelawan" USING btree ("ID Permohonan");


--
-- Name: MODUL1_PendaftaranRelawan_pending_ID_Relawan_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL1_PendaftaranRelawan_pending_ID_Relawan_app_key" ON public."MODUL1_PendaftaranRelawan" USING btree ("ID Relawan") WHERE ("Status" = ANY (ARRAY['Menunggu Persetujuan SUPER ADMIN'::text, 'Menunggu Verifikasi SUPER ADMIN'::text, 'Sedang Diproses'::text]));


--
-- Name: MODUL4_AnggaranPO_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_AnggaranPO_AppKey_app_key" ON public."MODUL4_AnggaranPO" USING btree ("AppKey");


--
-- Name: MODUL4_CloudSync_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_CloudSync_AppKey_app_key" ON public."MODUL4_CloudSync" USING btree ("AppKey");


--
-- Name: MODUL4_HACCP_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_HACCP_AppKey_app_key" ON public."MODUL4_HACCP" USING btree ("AppKey");


--
-- Name: MODUL4_JadwalDistribusi_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_JadwalDistribusi_AppKey_app_key" ON public."MODUL4_JadwalDistribusi" USING btree ("AppKey");


--
-- Name: MODUL4_Joblist_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_Joblist_AppKey_app_key" ON public."MODUL4_Joblist" USING btree ("AppKey");


--
-- Name: MODUL4_PosterAKG_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_PosterAKG_AppKey_app_key" ON public."MODUL4_PosterAKG" USING btree ("AppKey");


--
-- Name: MODUL4_Resep_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_Resep_AppKey_app_key" ON public."MODUL4_Resep" USING btree ("AppKey");


--
-- Name: MODUL4_TargetPorsi_AppKey_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MODUL4_TargetPorsi_AppKey_app_key" ON public."MODUL4_TargetPorsi" USING btree ("AppKey");


--
-- Name: SPAS1_BENEFICIARIES_ID_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SPAS1_BENEFICIARIES_ID_app_key" ON public."SPAS1_BENEFICIARIES" USING btree ("ID");


--
-- Name: SPAS1_SETTINGS_Pengaturan_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SPAS1_SETTINGS_Pengaturan_app_key" ON public."SPAS1_SETTINGS" USING btree ("Pengaturan");


--
-- Name: SPAS1_TEAM_ID_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SPAS1_TEAM_ID_app_key" ON public."SPAS1_TEAM" USING btree ("ID");


--
-- Name: aboutsky_archive_access_logs_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aboutsky_archive_access_logs_recent_idx ON public.aboutsky_archive_access_logs USING btree (accessed_at DESC);


--
-- Name: aboutsky_archive_files_folder_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aboutsky_archive_files_folder_order_idx ON public.aboutsky_archive_files USING btree (folder_id, sort_order, name);


--
-- Name: aboutsky_contact_rate_limits_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aboutsky_contact_rate_limits_window_idx ON public.aboutsky_contact_rate_limits USING btree (window_started_at);


--
-- Name: modul2_bank_menu_ID_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "modul2_bank_menu_ID_app_key" ON public.modul2_bank_menu USING btree ("ID");


--
-- Name: modul2_bank_menu_period_schedule_day_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX modul2_bank_menu_period_schedule_day_key ON public.modul2_bank_menu_period USING btree ("Periode Bulan", "Periode Hari", "Periode Minggu", "Menu ID");


--
-- Name: modul3_stok_logistik_ID_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "modul3_stok_logistik_ID_app_key" ON public.modul3_stok_logistik USING btree ("ID");


--
-- Name: modul3_stok_logistik_belanja_tanggal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_belanja_tanggal_idx ON public.modul3_stok_logistik_belanja_harian USING btree ("Tanggal" DESC);


--
-- Name: modul3_stok_logistik_kitchen_demo_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_kitchen_demo_date_idx ON public.modul3_stok_logistik_kitchen_demo USING btree ("Tanggal" DESC, "Diperbarui Pada" DESC);


--
-- Name: modul3_stok_logistik_pemakaian_tanggal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_pemakaian_tanggal_idx ON public.modul3_stok_logistik_pemakaian_harian USING btree ("Tanggal" DESC);


--
-- Name: modul3_stok_logistik_transaksi_belanja_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_transaksi_belanja_idx ON public.modul3_stok_logistik_transaksi USING btree ("ID Belanja");


--
-- Name: modul3_stok_logistik_transaksi_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_transaksi_item_idx ON public.modul3_stok_logistik_transaksi USING btree ("Item ID", "Tanggal" DESC);


--
-- Name: modul3_stok_logistik_transaksi_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX modul3_stok_logistik_transaksi_reference_key ON public.modul3_stok_logistik_transaksi USING btree ("Transaksi Referensi ID") WHERE ("Transaksi Referensi ID" IS NOT NULL);


--
-- Name: modul3_stok_logistik_transaksi_tanggal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modul3_stok_logistik_transaksi_tanggal_idx ON public.modul3_stok_logistik_transaksi USING btree ("Tanggal" DESC);


--
-- Name: modul3_stok_logistik_transaksi modul3_stok_logistik_return_void_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modul3_stok_logistik_return_void_guard BEFORE UPDATE OF "Status" ON public.modul3_stok_logistik_transaksi FOR EACH ROW EXECUTE FUNCTION public.guard_stok_logistik_return_void();


--
-- Name: MODUL1_Absensi_Drafts MODUL1_Absensi_Drafts_ID Absensi_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MODUL1_Absensi_Drafts"
    ADD CONSTRAINT "MODUL1_Absensi_Drafts_ID Absensi_fkey" FOREIGN KEY ("ID Absensi") REFERENCES public."MODUL1_Absensi"("ID Absensi") ON DELETE CASCADE;


--
-- Name: aboutsky_archive_access_logs aboutsky_archive_access_logs_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_access_logs
    ADD CONSTRAINT aboutsky_archive_access_logs_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: aboutsky_archive_access_logs aboutsky_archive_access_logs_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_access_logs
    ADD CONSTRAINT aboutsky_archive_access_logs_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.aboutsky_archive_folders(id) ON DELETE SET NULL;


--
-- Name: aboutsky_archive_files aboutsky_archive_files_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aboutsky_archive_files
    ADD CONSTRAINT aboutsky_archive_files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.aboutsky_archive_folders(id) ON DELETE CASCADE;


--
-- Name: modul3_stok_logistik_pemakaian_harian modul3_stok_logistik_pemakaian_h_Transaksi Pengembalian ID_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_pemakaian_harian
    ADD CONSTRAINT "modul3_stok_logistik_pemakaian_h_Transaksi Pengembalian ID_fkey" FOREIGN KEY ("Transaksi Pengembalian ID") REFERENCES public.modul3_stok_logistik_transaksi("ID");


--
-- Name: modul3_stok_logistik_pemakaian_harian modul3_stok_logistik_pemakaian_harian_Transaksi Keluar ID_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_pemakaian_harian
    ADD CONSTRAINT "modul3_stok_logistik_pemakaian_harian_Transaksi Keluar ID_fkey" FOREIGN KEY ("Transaksi Keluar ID") REFERENCES public.modul3_stok_logistik_transaksi("ID") ON DELETE CASCADE;


--
-- Name: modul3_stok_logistik_transaksi modul3_stok_logistik_transaksi_ID Belanja_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_transaksi
    ADD CONSTRAINT "modul3_stok_logistik_transaksi_ID Belanja_fkey" FOREIGN KEY ("ID Belanja") REFERENCES public.modul3_stok_logistik_belanja_harian("ID");


--
-- Name: modul3_stok_logistik_transaksi modul3_stok_logistik_transaksi_Transaksi Referensi ID_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modul3_stok_logistik_transaksi
    ADD CONSTRAINT "modul3_stok_logistik_transaksi_Transaksi Referensi ID_fkey" FOREIGN KEY ("Transaksi Referensi ID") REFERENCES public.modul3_stok_logistik_transaksi("ID");


--
-- Name: ADMIN_Login; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ADMIN_Login" ENABLE ROW LEVEL SECURITY;

--
-- Name: modul2_bank_menu Bank menu admin module manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bank menu admin module manage" ON public.modul2_bank_menu TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: modul2_bank_menu_period Bank menu period admin module manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bank menu period admin module manage" ON public.modul2_bank_menu_period TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: modul2_bank_menu Bank menu public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bank menu public read" ON public.modul2_bank_menu FOR SELECT TO anon USING (true);


--
-- Name: modul3_stok_logistik_belanja_harian Daily stock purchase admin read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Daily stock purchase admin read" ON public.modul3_stok_logistik_belanja_harian FOR SELECT TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: INFO_SPPG; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."INFO_SPPG" ENABLE ROW LEVEL SECURITY;

--
-- Name: INFO_SPPG INFO_SPPG admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "INFO_SPPG admin manage" ON public."INFO_SPPG" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: INFO_SPPG INFO_SPPG public published read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "INFO_SPPG public published read" ON public."INFO_SPPG" FOR SELECT TO authenticated, anon USING (("Status" = 'Published'::text));


--
-- Name: modul3_stok_logistik_kitchen_demo Kitchen demo admin module manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Kitchen demo admin module manage" ON public.modul3_stok_logistik_kitchen_demo TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: modul3_stok_logistik_pemakaian_harian Kitchen usage admin module read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Kitchen usage admin module read" ON public.modul3_stok_logistik_pemakaian_harian FOR SELECT TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: spas1_lpdh_reports LPDH admin insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPDH admin insert" ON public.spas1_lpdh_reports FOR INSERT TO authenticated WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: spas1_lpdh_reports LPDH admin read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPDH admin read" ON public.spas1_lpdh_reports FOR SELECT TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: spas1_lpdh_reports LPDH admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPDH admin update" ON public.spas1_lpdh_reports FOR UPDATE TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: spas1_lpj_reports LPJ admin insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPJ admin insert" ON public.spas1_lpj_reports FOR INSERT TO authenticated WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: spas1_lpj_reports LPJ admin read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPJ admin read" ON public.spas1_lpj_reports FOR SELECT TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: spas1_lpj_reports LPJ admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "LPJ admin update" ON public.spas1_lpj_reports FOR UPDATE TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: MODUL1_Absensi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL1_Absensi" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL1_Absensi MODUL1_Absensi admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL1_Absensi admin manage" ON public."MODUL1_Absensi" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: MODUL1_Absensi_Drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL1_Absensi_Drafts" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL1_Absensi_Drafts MODUL1_Absensi_Drafts admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL1_Absensi_Drafts admin manage" ON public."MODUL1_Absensi_Drafts" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: MODUL1_DataRelawan; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL1_DataRelawan" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL1_DataRelawan MODUL1_DataRelawan admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL1_DataRelawan admin manage" ON public."MODUL1_DataRelawan" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: MODUL1_DataRelawan MODUL1_DataRelawan employee read own active profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL1_DataRelawan employee read own active profile" ON public."MODUL1_DataRelawan" FOR SELECT TO authenticated USING ((("Auth User ID" = auth.uid()) AND ("Status Akun" = 'Aktif'::text)));


--
-- Name: MODUL1_PendaftaranRelawan; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL1_PendaftaranRelawan" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_AnggaranPO; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_AnggaranPO" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_AnggaranPO MODUL4_AnggaranPO_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_AnggaranPO_admin_module_access" ON public."MODUL4_AnggaranPO" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_CloudSync; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_CloudSync" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_CloudSync MODUL4_CloudSync_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_CloudSync_admin_module_access" ON public."MODUL4_CloudSync" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_HACCP; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_HACCP" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_HACCP MODUL4_HACCP_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_HACCP_admin_module_access" ON public."MODUL4_HACCP" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_JadwalDistribusi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_JadwalDistribusi" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_JadwalDistribusi MODUL4_JadwalDistribusi_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_JadwalDistribusi_admin_module_access" ON public."MODUL4_JadwalDistribusi" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_Joblist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_Joblist" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_Joblist MODUL4_Joblist_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_Joblist_admin_module_access" ON public."MODUL4_Joblist" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_PosterAKG; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_PosterAKG" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_PosterAKG MODUL4_PosterAKG_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_PosterAKG_admin_module_access" ON public."MODUL4_PosterAKG" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_Resep; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_Resep" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_Resep MODUL4_Resep_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_Resep_admin_module_access" ON public."MODUL4_Resep" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: MODUL4_TargetPorsi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MODUL4_TargetPorsi" ENABLE ROW LEVEL SECURITY;

--
-- Name: MODUL4_TargetPorsi MODUL4_TargetPorsi_admin_module_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "MODUL4_TargetPorsi_admin_module_access" ON public."MODUL4_TargetPorsi" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: SPAS1_BENEFICIARIES; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SPAS1_BENEFICIARIES" ENABLE ROW LEVEL SECURITY;

--
-- Name: SPAS1_BENEFICIARIES SPAS1_BENEFICIARIES admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_BENEFICIARIES admin manage" ON public."SPAS1_BENEFICIARIES" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: SPAS1_BENEFICIARIES SPAS1_BENEFICIARIES public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_BENEFICIARIES public read" ON public."SPAS1_BENEFICIARIES" FOR SELECT TO authenticated, anon USING (true);


--
-- Name: SPAS1_MEDIA; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SPAS1_MEDIA" ENABLE ROW LEVEL SECURITY;

--
-- Name: SPAS1_MEDIA SPAS1_MEDIA admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_MEDIA admin manage" ON public."SPAS1_MEDIA" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: SPAS1_MEDIA SPAS1_MEDIA public published read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_MEDIA public published read" ON public."SPAS1_MEDIA" FOR SELECT TO authenticated, anon USING (("Status" = 'Published'::text));


--
-- Name: SPAS1_SETTINGS; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SPAS1_SETTINGS" ENABLE ROW LEVEL SECURITY;

--
-- Name: SPAS1_SETTINGS SPAS1_SETTINGS admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_SETTINGS admin manage" ON public."SPAS1_SETTINGS" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: SPAS1_SETTINGS SPAS1_SETTINGS module operational state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_SETTINGS module operational state" ON public."SPAS1_SETTINGS" TO authenticated USING ((("Pengaturan" = 'operationalAppData'::text) AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])))) WITH CHECK ((("Pengaturan" = 'operationalAppData'::text) AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))));


--
-- Name: SPAS1_SETTINGS SPAS1_SETTINGS public safe read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_SETTINGS public safe read" ON public."SPAS1_SETTINGS" FOR SELECT TO authenticated, anon USING (("Pengaturan" = ANY (ARRAY['foundationName'::text, 'sppgName'::text, 'logoUrl'::text, 'logoFileId'::text, 'markUrl'::text, 'markFileId'::text, 'totalBeneficiaries'::text, 'volunteerCount'::text, 'siteContent'::text])));


--
-- Name: SPAS1_TEAM; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SPAS1_TEAM" ENABLE ROW LEVEL SECURITY;

--
-- Name: SPAS1_TEAM SPAS1_TEAM admin manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_TEAM admin manage" ON public."SPAS1_TEAM" TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));


--
-- Name: SPAS1_TEAM SPAS1_TEAM public approved read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SPAS1_TEAM public approved read" ON public."SPAS1_TEAM" FOR SELECT TO authenticated, anon USING (("Publikasi Disetujui" = 'true'::text));


--
-- Name: modul3_stok_logistik Stock admin module manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Stock admin module manage" ON public.modul3_stok_logistik TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text]))) WITH CHECK ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: modul3_stok_logistik_transaksi Stock movement admin module access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Stock movement admin module access" ON public.modul3_stok_logistik_transaksi FOR SELECT TO authenticated USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'module'::text])));


--
-- Name: modul3_stok_logistik Stock public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Stock public read" ON public.modul3_stok_logistik FOR SELECT TO anon USING (true);


--
-- Name: aboutsky_archive_access_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_archive_access_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_archive_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_archive_files ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_archive_folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_archive_folders ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_contact_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_contact_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_contact_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_contact_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_public_content; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aboutsky_public_content ENABLE ROW LEVEL SECURITY;

--
-- Name: aboutsky_public_content aboutsky_public_content_published_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aboutsky_public_content_published_read ON public.aboutsky_public_content FOR SELECT TO anon USING (published);


--
-- Name: modul2_bank_menu; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul2_bank_menu ENABLE ROW LEVEL SECURITY;

--
-- Name: modul2_bank_menu_period; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul2_bank_menu_period ENABLE ROW LEVEL SECURITY;

--
-- Name: modul3_stok_logistik; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik ENABLE ROW LEVEL SECURITY;

--
-- Name: modul3_stok_logistik_belanja_harian; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik_belanja_harian ENABLE ROW LEVEL SECURITY;

--
-- Name: modul3_stok_logistik_kitchen_demo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik_kitchen_demo ENABLE ROW LEVEL SECURITY;

--
-- Name: modul3_stok_logistik_pemakaian_harian; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik_pemakaian_harian ENABLE ROW LEVEL SECURITY;

--
-- Name: modul3_stok_logistik_transaksi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modul3_stok_logistik_transaksi ENABLE ROW LEVEL SECURITY;

--
-- Name: spas1_lpdh_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spas1_lpdh_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: spas1_lpj_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spas1_lpj_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION aboutsky_allow_contact(p_ip_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.aboutsky_allow_contact(p_ip_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.aboutsky_allow_contact(p_ip_hash text) TO service_role;


--
-- Name: FUNCTION guard_stok_logistik_return_void(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_stok_logistik_return_void() TO anon;
GRANT ALL ON FUNCTION public.guard_stok_logistik_return_void() TO authenticated;
GRANT ALL ON FUNCTION public.guard_stok_logistik_return_void() TO service_role;


--
-- Name: FUNCTION record_stok_logistik_daily_purchase(p_supplier text, p_note text, p_location text, p_photo_path text, p_items jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_stok_logistik_daily_purchase(p_supplier text, p_note text, p_location text, p_photo_path text, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_stok_logistik_daily_purchase(p_supplier text, p_note text, p_location text, p_photo_path text, p_items jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.record_stok_logistik_daily_purchase(p_supplier text, p_note text, p_location text, p_photo_path text, p_items jsonb) TO service_role;


--
-- Name: FUNCTION record_stok_logistik_kitchen_usage(p_movement_id uuid, p_used_primary_quantity numeric, p_used_small_quantity numeric, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_stok_logistik_kitchen_usage(p_movement_id uuid, p_used_primary_quantity numeric, p_used_small_quantity numeric, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_stok_logistik_kitchen_usage(p_movement_id uuid, p_used_primary_quantity numeric, p_used_small_quantity numeric, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.record_stok_logistik_kitchen_usage(p_movement_id uuid, p_used_primary_quantity numeric, p_used_small_quantity numeric, p_note text) TO service_role;


--
-- Name: FUNCTION record_stok_logistik_movement(p_item_id text, p_type text, p_quantity numeric, p_unit_price numeric, p_supplier text, p_note text, p_weekday text, p_location text, p_photo_path text, p_small_quantity numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_stok_logistik_movement(p_item_id text, p_type text, p_quantity numeric, p_unit_price numeric, p_supplier text, p_note text, p_weekday text, p_location text, p_photo_path text, p_small_quantity numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_stok_logistik_movement(p_item_id text, p_type text, p_quantity numeric, p_unit_price numeric, p_supplier text, p_note text, p_weekday text, p_location text, p_photo_path text, p_small_quantity numeric) TO authenticated;
GRANT ALL ON FUNCTION public.record_stok_logistik_movement(p_item_id text, p_type text, p_quantity numeric, p_unit_price numeric, p_supplier text, p_note text, p_weekday text, p_location text, p_photo_path text, p_small_quantity numeric) TO service_role;


--
-- Name: FUNCTION return_stok_logistik_kitchen_remainder(p_movement_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.return_stok_logistik_kitchen_remainder(p_movement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.return_stok_logistik_kitchen_remainder(p_movement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.return_stok_logistik_kitchen_remainder(p_movement_id uuid) TO service_role;


--
-- Name: FUNCTION void_stok_logistik_transaction(p_movement_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.void_stok_logistik_transaction(p_movement_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.void_stok_logistik_transaction(p_movement_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.void_stok_logistik_transaction(p_movement_id uuid, p_reason text) TO service_role;


--
-- Name: TABLE "ADMIN_Login"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."ADMIN_Login" TO anon;
GRANT ALL ON TABLE public."ADMIN_Login" TO authenticated;
GRANT ALL ON TABLE public."ADMIN_Login" TO service_role;


--
-- Name: TABLE "INFO_SPPG"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."INFO_SPPG" TO anon;
GRANT ALL ON TABLE public."INFO_SPPG" TO authenticated;
GRANT ALL ON TABLE public."INFO_SPPG" TO service_role;


--
-- Name: TABLE "MODUL1_Absensi"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL1_Absensi" TO anon;
GRANT ALL ON TABLE public."MODUL1_Absensi" TO authenticated;
GRANT ALL ON TABLE public."MODUL1_Absensi" TO service_role;


--
-- Name: TABLE "MODUL1_Absensi_Drafts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL1_Absensi_Drafts" TO anon;
GRANT ALL ON TABLE public."MODUL1_Absensi_Drafts" TO authenticated;
GRANT ALL ON TABLE public."MODUL1_Absensi_Drafts" TO service_role;


--
-- Name: TABLE "MODUL1_DataRelawan"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL1_DataRelawan" TO anon;
GRANT ALL ON TABLE public."MODUL1_DataRelawan" TO authenticated;
GRANT ALL ON TABLE public."MODUL1_DataRelawan" TO service_role;


--
-- Name: TABLE "MODUL1_PendaftaranRelawan"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL1_PendaftaranRelawan" TO anon;
GRANT ALL ON TABLE public."MODUL1_PendaftaranRelawan" TO authenticated;
GRANT ALL ON TABLE public."MODUL1_PendaftaranRelawan" TO service_role;


--
-- Name: TABLE "MODUL4_AnggaranPO"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_AnggaranPO" TO anon;
GRANT ALL ON TABLE public."MODUL4_AnggaranPO" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_AnggaranPO" TO service_role;


--
-- Name: TABLE "MODUL4_CloudSync"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_CloudSync" TO anon;
GRANT ALL ON TABLE public."MODUL4_CloudSync" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_CloudSync" TO service_role;


--
-- Name: TABLE "MODUL4_HACCP"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_HACCP" TO anon;
GRANT ALL ON TABLE public."MODUL4_HACCP" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_HACCP" TO service_role;


--
-- Name: TABLE "MODUL4_JadwalDistribusi"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_JadwalDistribusi" TO anon;
GRANT ALL ON TABLE public."MODUL4_JadwalDistribusi" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_JadwalDistribusi" TO service_role;


--
-- Name: TABLE "MODUL4_Joblist"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_Joblist" TO anon;
GRANT ALL ON TABLE public."MODUL4_Joblist" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_Joblist" TO service_role;


--
-- Name: TABLE "MODUL4_PosterAKG"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_PosterAKG" TO anon;
GRANT ALL ON TABLE public."MODUL4_PosterAKG" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_PosterAKG" TO service_role;


--
-- Name: TABLE "MODUL4_Resep"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_Resep" TO anon;
GRANT ALL ON TABLE public."MODUL4_Resep" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_Resep" TO service_role;


--
-- Name: TABLE "MODUL4_TargetPorsi"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."MODUL4_TargetPorsi" TO anon;
GRANT ALL ON TABLE public."MODUL4_TargetPorsi" TO authenticated;
GRANT ALL ON TABLE public."MODUL4_TargetPorsi" TO service_role;


--
-- Name: TABLE "SPAS1_BENEFICIARIES"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."SPAS1_BENEFICIARIES" TO anon;
GRANT ALL ON TABLE public."SPAS1_BENEFICIARIES" TO authenticated;
GRANT ALL ON TABLE public."SPAS1_BENEFICIARIES" TO service_role;


--
-- Name: TABLE "SPAS1_MEDIA"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."SPAS1_MEDIA" TO anon;
GRANT ALL ON TABLE public."SPAS1_MEDIA" TO authenticated;
GRANT ALL ON TABLE public."SPAS1_MEDIA" TO service_role;


--
-- Name: TABLE "SPAS1_SETTINGS"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."SPAS1_SETTINGS" TO anon;
GRANT ALL ON TABLE public."SPAS1_SETTINGS" TO authenticated;
GRANT ALL ON TABLE public."SPAS1_SETTINGS" TO service_role;


--
-- Name: TABLE "SPAS1_TEAM"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public."SPAS1_TEAM" TO anon;
GRANT ALL ON TABLE public."SPAS1_TEAM" TO authenticated;
GRANT ALL ON TABLE public."SPAS1_TEAM" TO service_role;


--
-- Name: TABLE aboutsky_archive_access_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_archive_access_logs TO service_role;


--
-- Name: TABLE aboutsky_archive_files; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_archive_files TO service_role;


--
-- Name: TABLE aboutsky_archive_folders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_archive_folders TO service_role;


--
-- Name: TABLE aboutsky_contact_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_contact_messages TO service_role;


--
-- Name: TABLE aboutsky_contact_rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_contact_rate_limits TO service_role;


--
-- Name: TABLE aboutsky_public_content; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aboutsky_public_content TO service_role;
GRANT SELECT ON TABLE public.aboutsky_public_content TO anon;


--
-- Name: TABLE modul2_bank_menu; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul2_bank_menu TO anon;
GRANT ALL ON TABLE public.modul2_bank_menu TO authenticated;
GRANT ALL ON TABLE public.modul2_bank_menu TO service_role;


--
-- Name: SEQUENCE modul2_bank_menu_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.modul2_bank_menu_id_seq TO anon;
GRANT ALL ON SEQUENCE public.modul2_bank_menu_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.modul2_bank_menu_id_seq TO service_role;


--
-- Name: TABLE modul2_bank_menu_period; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul2_bank_menu_period TO anon;
GRANT ALL ON TABLE public.modul2_bank_menu_period TO authenticated;
GRANT ALL ON TABLE public.modul2_bank_menu_period TO service_role;


--
-- Name: TABLE modul3_stok_logistik; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul3_stok_logistik TO anon;
GRANT ALL ON TABLE public.modul3_stok_logistik TO authenticated;
GRANT ALL ON TABLE public.modul3_stok_logistik TO service_role;


--
-- Name: TABLE modul3_stok_logistik_belanja_harian; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul3_stok_logistik_belanja_harian TO anon;
GRANT ALL ON TABLE public.modul3_stok_logistik_belanja_harian TO authenticated;
GRANT ALL ON TABLE public.modul3_stok_logistik_belanja_harian TO service_role;


--
-- Name: SEQUENCE modul3_stok_logistik_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.modul3_stok_logistik_id_seq TO anon;
GRANT ALL ON SEQUENCE public.modul3_stok_logistik_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.modul3_stok_logistik_id_seq TO service_role;


--
-- Name: TABLE modul3_stok_logistik_kitchen_demo; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul3_stok_logistik_kitchen_demo TO anon;
GRANT ALL ON TABLE public.modul3_stok_logistik_kitchen_demo TO authenticated;
GRANT ALL ON TABLE public.modul3_stok_logistik_kitchen_demo TO service_role;


--
-- Name: TABLE modul3_stok_logistik_pemakaian_harian; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul3_stok_logistik_pemakaian_harian TO anon;
GRANT ALL ON TABLE public.modul3_stok_logistik_pemakaian_harian TO authenticated;
GRANT ALL ON TABLE public.modul3_stok_logistik_pemakaian_harian TO service_role;


--
-- Name: TABLE modul3_stok_logistik_transaksi; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.modul3_stok_logistik_transaksi TO anon;
GRANT ALL ON TABLE public.modul3_stok_logistik_transaksi TO authenticated;
GRANT ALL ON TABLE public.modul3_stok_logistik_transaksi TO service_role;


--
-- Name: TABLE spas1_lpdh_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.spas1_lpdh_reports TO authenticated;
GRANT ALL ON TABLE public.spas1_lpdh_reports TO service_role;


--
-- Name: TABLE spas1_lpj_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.spas1_lpj_reports TO authenticated;
GRANT ALL ON TABLE public.spas1_lpj_reports TO service_role;


-- PostgreSQL database dump complete
--

COMMIT;
