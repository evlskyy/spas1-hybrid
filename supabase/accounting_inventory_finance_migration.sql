-- Accounting workflows for stock opname and finance.
-- Apply after supabase_migration.sql and the tenant/account-access migrations.

create table if not exists public.spas1_stock_opnames (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  opname_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved', 'rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  rejection_reason text,
  applied_at timestamptz,
  check (length(note) <= 500),
  check (rejection_reason is null or length(rejection_reason) <= 500)
);

create table if not exists public.spas1_stock_opname_lines (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  opname_id uuid not null references public.spas1_stock_opnames(id) on delete cascade,
  item_id text not null,
  item_name text not null,
  category text not null default '',
  unit text not null default '',
  expected_quantity numeric not null check (expected_quantity >= 0),
  counted_quantity numeric check (counted_quantity is null or counted_quantity >= 0),
  difference numeric,
  unique (opname_id, item_id)
);

create index if not exists spas1_stock_opnames_tenant_date_idx
  on public.spas1_stock_opnames (sppg_id, opname_date desc, created_at desc);
create index if not exists spas1_stock_opname_lines_parent_idx
  on public.spas1_stock_opname_lines (sppg_id, opname_id, item_name);

alter table public.spas1_stock_opnames enable row level security;
alter table public.spas1_stock_opname_lines enable row level security;
revoke all on public.spas1_stock_opnames, public.spas1_stock_opname_lines from public, anon;
grant select on public.spas1_stock_opnames, public.spas1_stock_opname_lines to authenticated;

drop policy if exists "Stock opname tenant admin read" on public.spas1_stock_opnames;
create policy "Stock opname tenant admin read"
on public.spas1_stock_opnames for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Stock opname lines tenant admin read" on public.spas1_stock_opname_lines;
create policy "Stock opname lines tenant admin read"
on public.spas1_stock_opname_lines for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create table if not exists public.spas1_finance_transactions (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('saldo_awal', 'pemasukan', 'pengeluaran')),
  transaction_date date not null,
  category text not null,
  description text not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_method text not null,
  reference text not null default '',
  receipt_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  rejection_reason text,
  check (length(btrim(category)) between 1 and 100),
  check (length(btrim(description)) between 1 and 500),
  check (length(btrim(payment_method)) between 1 and 100),
  check (length(reference) <= 160),
  check (receipt_path is null or length(receipt_path) <= 500),
  check (rejection_reason is null or length(rejection_reason) <= 500)
);

create unique index if not exists spas1_finance_single_opening_balance_key
  on public.spas1_finance_transactions (sppg_id)
  where transaction_type = 'saldo_awal' and status in ('pending', 'approved');
create index if not exists spas1_finance_transactions_tenant_date_idx
  on public.spas1_finance_transactions (sppg_id, transaction_date desc, created_at desc);

create table if not exists public.spas1_finance_transaction_audit (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  transaction_id uuid not null,
  action text not null check (action in ('updated', 'approved', 'rejected', 'deleted')),
  before_data jsonb not null,
  after_data jsonb,
  changed_at timestamptz not null default now(),
  changed_by uuid not null default auth.uid()
);

create index if not exists spas1_finance_transaction_audit_tenant_idx
  on public.spas1_finance_transaction_audit (sppg_id, transaction_id, changed_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'spas1-finance',
  'spas1-finance',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "SPAS1 finance receipt tenant read" on storage.objects;
create policy "SPAS1 finance receipt tenant read"
on storage.objects for select to authenticated
using (
  bucket_id = 'spas1-finance'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (storage.foldername(name))[2] = 'akuntan-keuangan'
);

drop policy if exists "SPAS1 finance receipt tenant upload" on storage.objects;
create policy "SPAS1 finance receipt tenant upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'spas1-finance'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and (storage.foldername(name))[1] = public.spas1_current_storage_folder()
  and (storage.foldername(name))[2] = 'akuntan-keuangan'
);

alter table public.spas1_finance_transactions enable row level security;
alter table public.spas1_finance_transaction_audit enable row level security;
revoke all on public.spas1_finance_transactions, public.spas1_finance_transaction_audit from public, anon;
grant select on public.spas1_finance_transactions, public.spas1_finance_transaction_audit to authenticated;

drop policy if exists "Finance transaction tenant admin read" on public.spas1_finance_transactions;
create policy "Finance transaction tenant admin read"
on public.spas1_finance_transactions for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Finance audit tenant admin read" on public.spas1_finance_transaction_audit;
create policy "Finance audit tenant admin read"
on public.spas1_finance_transaction_audit for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Opname adjustments need to be recorded even when the approval falls on a weekend.
alter table public."modul3_stok_logistik_transaksi"
  drop constraint if exists "modul3_stok_logistik_transaksi_Hari_check";
alter table public."modul3_stok_logistik_transaksi"
  add constraint "modul3_stok_logistik_transaksi_Hari_check"
  check ("Hari" in ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'));

create or replace function public.spas1_save_stock_opname(
  p_opname_id uuid,
  p_opname_date date,
  p_note text,
  p_lines jsonb,
  p_submit boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_opname public.spas1_stock_opnames%rowtype;
  v_line jsonb;
  v_item public."modul3_stok_logistik"%rowtype;
  v_item_id text;
  v_counted numeric;
  v_item_count integer;
  v_saved_count integer := 0;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Fitur Akuntan hanya tersedia untuk SUPER ADMIN.';
  end if;
  if v_sppg_id is null or p_opname_date is null
     or p_opname_date > (now() at time zone 'Asia/Jakarta')::date
     or length(coalesce(p_note, '')) > 500
     or p_lines is null
     or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Tanggal, catatan, atau daftar item opname tidak valid.';
  end if;
  if jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 1000 then
    raise exception 'Daftar opname harus memuat antara 1 dan 1000 item.';
  end if;

  select count(*) into v_item_count
  from public."modul3_stok_logistik"
  where sppg_id = v_sppg_id;
  if v_item_count <> jsonb_array_length(p_lines) then
    raise exception 'Daftar opname tidak sesuai dengan item stok aktif. Muat ulang daftar stok.';
  end if;

  if p_opname_id is null then
    insert into public.spas1_stock_opnames (
      sppg_id, opname_date, status, note, submitted_at
    ) values (
      v_sppg_id, p_opname_date, case when p_submit then 'pending' else 'draft' end,
      btrim(coalesce(p_note, '')), case when p_submit then now() else null end
    ) returning * into v_opname;
  else
    select * into v_opname
    from public.spas1_stock_opnames
    where id = p_opname_id and sppg_id = v_sppg_id
    for update;
    if not found or v_opname.status not in ('draft', 'rejected') then
      raise exception 'Opname tidak ditemukan atau sudah diajukan.';
    end if;
    update public.spas1_stock_opnames
    set opname_date = p_opname_date,
        note = btrim(coalesce(p_note, '')),
        status = case when p_submit then 'pending' else 'draft' end,
        submitted_at = case when p_submit then now() else null end,
        rejected_at = null,
        rejected_by = null,
        rejection_reason = null
    where id = p_opname_id and sppg_id = v_sppg_id
    returning * into v_opname;
    delete from public.spas1_stock_opname_lines
    where opname_id = p_opname_id and sppg_id = v_sppg_id;
  end if;

  for v_line in
    select value from jsonb_array_elements(p_lines)
  loop
    v_item_id := nullif(btrim(v_line ->> 'item_id'), '');
    if v_item_id is null or v_item_id !~ '^[0-9]+$' then
      raise exception 'ID item stok pada opname tidak valid.';
    end if;
    if v_line ? 'counted_quantity' and v_line -> 'counted_quantity' <> 'null'::jsonb then
      if coalesce(v_line ->> 'counted_quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' then
        raise exception 'Jumlah stok fisik harus berupa angka nol atau lebih, maksimal tiga angka desimal.';
      end if;
      v_counted := (v_line ->> 'counted_quantity')::numeric;
      if v_counted < 0 then raise exception 'Jumlah stok fisik tidak boleh negatif.'; end if;
    else
      v_counted := null;
    end if;
    if p_submit and v_counted is null then
      raise exception 'Isi hasil hitung fisik untuk semua item sebelum mengajukan opname.';
    end if;

    select * into v_item
    from public."modul3_stok_logistik"
    where "ID"::text = v_item_id and sppg_id = v_sppg_id;
    if not found then raise exception 'Item stok tidak ditemukan pada SPPG ini.'; end if;

    insert into public.spas1_stock_opname_lines (
      sppg_id, opname_id, item_id, item_name, category, unit,
      expected_quantity, counted_quantity, difference
    ) values (
      v_sppg_id, v_opname.id, v_item_id,
      coalesce(v_item."Nama Item", ''), coalesce(v_item."Kategori", ''),
      coalesce(v_item."Satuan", ''),
      coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric,
      v_counted,
      case when v_counted is null then null
           else v_counted - coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric end
    );
    v_saved_count := v_saved_count + 1;
  end loop;

  return jsonb_build_object(
    'id', v_opname.id,
    'status', v_opname.status,
    'line_count', v_saved_count
  );
end;
$$;

create or replace function public.spas1_approve_stock_opname(p_opname_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_opname public.spas1_stock_opnames%rowtype;
  v_line public.spas1_stock_opname_lines%rowtype;
  v_item public."modul3_stok_logistik"%rowtype;
  v_before numeric;
  v_after numeric;
  v_delta numeric;
  v_timestamp timestamptz := clock_timestamp();
  v_weekday text;
  v_adjustments integer := 0;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat menyetujui opname.';
  end if;
  if v_sppg_id is null or p_opname_id is null then
    raise exception 'Identitas SPPG atau opname tidak valid.';
  end if;

  select * into v_opname
  from public.spas1_stock_opnames
  where id = p_opname_id and sppg_id = v_sppg_id
  for update;
  if not found or v_opname.status <> 'pending' or v_opname.applied_at is not null then
    raise exception 'Opname tidak ditemukan, belum diajukan, atau sudah diproses.';
  end if;
  if not exists (
    select 1 from public.spas1_stock_opname_lines
    where opname_id = p_opname_id and sppg_id = v_sppg_id
  ) or exists (
    select 1 from public.spas1_stock_opname_lines
    where opname_id = p_opname_id and sppg_id = v_sppg_id
      and counted_quantity is null
  ) then
    raise exception 'Opname belum memiliki hasil hitung lengkap.';
  end if;

  v_weekday := case extract(isodow from (v_timestamp at time zone 'Asia/Jakarta'))
    when 1 then 'Senin' when 2 then 'Selasa' when 3 then 'Rabu'
    when 4 then 'Kamis' when 5 then 'Jumat' when 6 then 'Sabtu'
    else 'Minggu'
  end;

  for v_line in
    select * from public.spas1_stock_opname_lines
    where opname_id = p_opname_id and sppg_id = v_sppg_id
    order by item_id
  loop
    select * into v_item
    from public."modul3_stok_logistik"
    where "ID"::text = v_line.item_id and sppg_id = v_sppg_id
    for update;
    if not found then raise exception 'Item % tidak lagi tersedia pada stok SPPG.', v_line.item_name; end if;
    v_before := coalesce(nullif(v_item."Stok"::text, ''), '0')::numeric;
    if v_before <> v_line.expected_quantity then
      raise exception 'Stok % berubah sejak opname dibuat. Muat ulang stok dan buat opname baru.', v_line.item_name;
    end if;
    v_delta := v_line.counted_quantity - v_before;
    if v_delta = 0 then continue; end if;
    v_after := v_line.counted_quantity;
    update public."modul3_stok_logistik"
    set "Stok" = v_after
    where "ID" = v_item."ID" and sppg_id = v_sppg_id;
    insert into public."modul3_stok_logistik_transaksi" (
      "Tipe", "Item ID", "Kategori", "Nama Item", "Satuan",
      "Satuan Pecahan", "Faktor Konversi", "Jumlah Utama", "Jumlah Pecahan",
      "Jumlah", "Stok Sebelum", "Stok Sesudah", "Harga Satuan", "Supplier",
      "Catatan", "Tanggal", "Hari", "Lokasi", "Foto Path", "Dibuat Oleh",
      sppg_id
    ) values (
      case when v_delta > 0 then 'Masuk' else 'Keluar' end,
      v_line.item_id, coalesce(v_item."Kategori", ''), coalesce(v_item."Nama Item", ''),
      coalesce(v_item."Satuan", ''), coalesce(v_item."Satuan Pecahan", ''),
      v_item."Faktor Konversi", abs(v_delta), 0, abs(v_delta), v_before, v_after,
      null, '', 'Penyesuaian Stok Opname ' || v_opname.id::text, v_timestamp,
      v_weekday, 'Audit Stok Opname', '', auth.uid(), v_sppg_id
    );
    v_adjustments := v_adjustments + 1;
  end loop;

  update public.spas1_stock_opnames
  set status = 'approved', approved_at = v_timestamp, approved_by = auth.uid(),
      applied_at = v_timestamp
  where id = p_opname_id and sppg_id = v_sppg_id;
  return jsonb_build_object('id', p_opname_id, 'adjustments', v_adjustments);
end;
$$;

create or replace function public.spas1_reject_stock_opname(p_opname_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat menolak opname.';
  end if;
  if v_sppg_id is null or p_opname_id is null
     or nullif(btrim(p_reason), '') is null or length(p_reason) > 500 then
    raise exception 'Alasan penolakan wajib diisi (maksimal 500 karakter).';
  end if;
  update public.spas1_stock_opnames
  set status = 'rejected', rejected_at = now(), rejected_by = auth.uid(),
      rejection_reason = btrim(p_reason)
  where id = p_opname_id and sppg_id = v_sppg_id and status = 'pending'
  returning id into p_opname_id;
  if not found then raise exception 'Opname tidak ditemukan atau sudah diproses.'; end if;
  return jsonb_build_object('status', 'rejected', 'id', p_opname_id);
end;
$$;

create or replace function public.spas1_save_finance_transaction(
  p_transaction_id uuid,
  p_transaction_type text,
  p_transaction_date date,
  p_category text,
  p_description text,
  p_amount numeric,
  p_payment_method text,
  p_reference text,
  p_receipt_path text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_transaction public.spas1_finance_transactions%rowtype;
  v_before jsonb;
  v_balance numeric;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Fitur Akuntan hanya tersedia untuk SUPER ADMIN.';
  end if;
  if v_sppg_id is null
     or p_transaction_type is null
     or p_transaction_type not in ('saldo_awal', 'pemasukan', 'pengeluaran')
     or p_transaction_date is null
     or p_transaction_date > (now() at time zone 'Asia/Jakarta')::date
     or nullif(btrim(p_category), '') is null or length(p_category) > 100
     or nullif(btrim(p_description), '') is null or length(p_description) > 500
     or p_amount is null or p_amount <= 0 or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <> round(p_amount, 2)
     or nullif(btrim(p_payment_method), '') is null or length(p_payment_method) > 100
     or length(coalesce(p_reference, '')) > 160
     or (p_receipt_path is not null and (
       split_part(p_receipt_path, '/', 1) <> public.spas1_current_storage_folder()
       or p_receipt_path !~ '^[a-z0-9-]+/akuntan-keuangan/[^/]+\.(jpeg|png|webp)$'
     ))
     or (p_transaction_type <> 'saldo_awal' and p_receipt_path is null) then
    raise exception 'Data transaksi tidak valid. Bukti foto wajib untuk pemasukan dan pengeluaran.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_sppg_id::text, 0));
  if p_transaction_id is null then
    insert into public.spas1_finance_transactions (
      sppg_id, transaction_type, transaction_date, category, description,
      amount, payment_method, reference, receipt_path
    ) values (
      v_sppg_id, p_transaction_type, p_transaction_date, btrim(p_category),
      btrim(p_description), p_amount, btrim(p_payment_method),
      btrim(coalesce(p_reference, '')), p_receipt_path
    ) returning * into v_transaction;
  else
    select * into v_transaction
    from public.spas1_finance_transactions
    where id = p_transaction_id and sppg_id = v_sppg_id
    for update;
    if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
    v_before := to_jsonb(v_transaction);
    if v_transaction.status = 'approved' then
      select coalesce(sum(
        case when transaction_type in ('saldo_awal', 'pemasukan') then amount
             when transaction_type = 'pengeluaran' then -amount else 0 end
      ), 0) into v_balance
      from public.spas1_finance_transactions
      where sppg_id = v_sppg_id and status = 'approved' and id <> p_transaction_id;
      if v_balance < 0 then
        raise exception 'Perubahan tidak dapat disimpan karena saldo transaksi lain menjadi negatif.';
      end if;
    end if;
    update public.spas1_finance_transactions
    set transaction_type = p_transaction_type,
        transaction_date = p_transaction_date,
        category = btrim(p_category),
        description = btrim(p_description),
        amount = p_amount,
        payment_method = btrim(p_payment_method),
        reference = btrim(coalesce(p_reference, '')),
        receipt_path = p_receipt_path,
        status = 'pending',
        updated_at = now(),
        approved_at = null,
        approved_by = null,
        rejected_at = null,
        rejected_by = null,
        rejection_reason = null
    where id = p_transaction_id and sppg_id = v_sppg_id
    returning * into v_transaction;
    insert into public.spas1_finance_transaction_audit (
      sppg_id, transaction_id, action, before_data, after_data
    ) values (v_sppg_id, p_transaction_id, 'updated', v_before, to_jsonb(v_transaction));
  end if;
  return jsonb_build_object('id', v_transaction.id, 'status', v_transaction.status);
end;
$$;

create or replace function public.spas1_approve_finance_transaction(p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_transaction public.spas1_finance_transactions%rowtype;
  v_before jsonb;
  v_balance numeric;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat menyetujui transaksi.';
  end if;
  if v_sppg_id is null or p_transaction_id is null then
    raise exception 'Identitas transaksi atau SPPG tidak valid.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_sppg_id::text, 0));
  select * into v_transaction
  from public.spas1_finance_transactions
  where id = p_transaction_id and sppg_id = v_sppg_id
  for update;
  if not found or v_transaction.status <> 'pending' then
    raise exception 'Transaksi tidak ditemukan atau sudah diproses.';
  end if;
  v_before := to_jsonb(v_transaction);
  select coalesce(sum(
    case when transaction_type in ('saldo_awal', 'pemasukan') then amount
         when transaction_type = 'pengeluaran' then -amount else 0 end
  ), 0) into v_balance
  from public.spas1_finance_transactions
  where sppg_id = v_sppg_id and status = 'approved';
  if v_transaction.transaction_type = 'pengeluaran'
     and v_balance < v_transaction.amount then
    raise exception 'Saldo tidak mencukupi untuk menyetujui pengeluaran ini.';
  end if;
  update public.spas1_finance_transactions
  set status = 'approved', approved_at = now(), approved_by = auth.uid(),
      rejected_at = null, rejected_by = null, rejection_reason = null,
      updated_at = now()
  where id = p_transaction_id and sppg_id = v_sppg_id;
  select * into v_transaction
  from public.spas1_finance_transactions
  where id = p_transaction_id and sppg_id = v_sppg_id;
  insert into public.spas1_finance_transaction_audit (
    sppg_id, transaction_id, action, before_data, after_data
  ) values (v_sppg_id, p_transaction_id, 'approved', v_before, to_jsonb(v_transaction));
  return jsonb_build_object('id', p_transaction_id, 'status', 'approved');
end;
$$;

create or replace function public.spas1_reject_finance_transaction(
  p_transaction_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_transaction public.spas1_finance_transactions%rowtype;
  v_before jsonb;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat menolak transaksi.';
  end if;
  if v_sppg_id is null or p_transaction_id is null
     or nullif(btrim(p_reason), '') is null or length(p_reason) > 500 then
    raise exception 'Alasan penolakan wajib diisi (maksimal 500 karakter).';
  end if;
  select * into v_transaction
  from public.spas1_finance_transactions
  where id = p_transaction_id and sppg_id = v_sppg_id
  for update;
  if not found or v_transaction.status <> 'pending' then
    raise exception 'Transaksi tidak ditemukan atau sudah diproses.';
  end if;
  v_before := to_jsonb(v_transaction);
  update public.spas1_finance_transactions
  set status = 'rejected', rejected_at = now(), rejected_by = auth.uid(),
      rejection_reason = btrim(p_reason), updated_at = now()
  where id = p_transaction_id and sppg_id = v_sppg_id
  returning * into v_transaction;
  insert into public.spas1_finance_transaction_audit (
    sppg_id, transaction_id, action, before_data, after_data
  ) values (v_sppg_id, p_transaction_id, 'rejected', v_before, to_jsonb(v_transaction));
  return jsonb_build_object('id', p_transaction_id, 'status', 'rejected');
end;
$$;

create or replace function public.spas1_delete_finance_transaction(p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_transaction public.spas1_finance_transactions%rowtype;
  v_balance numeric;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat menghapus transaksi.';
  end if;
  if v_sppg_id is null or p_transaction_id is null then
    raise exception 'Identitas transaksi atau SPPG tidak valid.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_sppg_id::text, 0));
  select * into v_transaction
  from public.spas1_finance_transactions
  where id = p_transaction_id and sppg_id = v_sppg_id
  for update;
  if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
  if v_transaction.status = 'approved' then
    select coalesce(sum(
      case when transaction_type in ('saldo_awal', 'pemasukan') then amount
           when transaction_type = 'pengeluaran' then -amount else 0 end
    ), 0) into v_balance
    from public.spas1_finance_transactions
    where sppg_id = v_sppg_id and status = 'approved' and id <> p_transaction_id;
    if v_balance < 0 then
      raise exception 'Transaksi ini tidak dapat dihapus karena saldo berjalan akan menjadi negatif.';
    end if;
  end if;
  insert into public.spas1_finance_transaction_audit (
    sppg_id, transaction_id, action, before_data
  ) values (v_sppg_id, p_transaction_id, 'deleted', to_jsonb(v_transaction));
  delete from public.spas1_finance_transactions
  where id = p_transaction_id and sppg_id = v_sppg_id;
  return jsonb_build_object('id', p_transaction_id, 'status', 'deleted');
end;
$$;

revoke all on function public.spas1_save_stock_opname(uuid, date, text, jsonb, boolean) from public, anon;
revoke all on function public.spas1_approve_stock_opname(uuid) from public, anon;
revoke all on function public.spas1_reject_stock_opname(uuid, text) from public, anon;
revoke all on function public.spas1_save_finance_transaction(uuid, text, date, text, text, numeric, text, text, text) from public, anon;
revoke all on function public.spas1_approve_finance_transaction(uuid) from public, anon;
revoke all on function public.spas1_reject_finance_transaction(uuid, text) from public, anon;
revoke all on function public.spas1_delete_finance_transaction(uuid) from public, anon;

grant execute on function public.spas1_save_stock_opname(uuid, date, text, jsonb, boolean) to authenticated;
grant execute on function public.spas1_approve_stock_opname(uuid) to authenticated;
grant execute on function public.spas1_reject_stock_opname(uuid, text) to authenticated;
grant execute on function public.spas1_save_finance_transaction(uuid, text, date, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.spas1_approve_finance_transaction(uuid) to authenticated;
grant execute on function public.spas1_reject_finance_transaction(uuid, text) to authenticated;
grant execute on function public.spas1_delete_finance_transaction(uuid) to authenticated;
