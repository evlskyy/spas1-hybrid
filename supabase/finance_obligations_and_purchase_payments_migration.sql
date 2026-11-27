-- Link supplier purchase payments, payables, receivables, and cash-balance movements.
-- Apply after purchase_order_management_migration.sql and
-- accounting_inventory_finance_migration.sql.

alter table public."modul3_stok_logistik_belanja_harian"
  add column if not exists "Status Pembayaran" text not null default 'Belum Dicatat';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.modul3_stok_logistik_belanja_harian'::regclass
      and conname = 'modul3_stok_logistik_belanja_payment_status_check'
  ) then
    alter table public."modul3_stok_logistik_belanja_harian"
      add constraint modul3_stok_logistik_belanja_payment_status_check
      check ("Status Pembayaran" in ('Belum Dicatat', 'Cash/Lunas', 'Hutang', 'Hutang Sebagian', 'Lunas', 'Dibatalkan'));
  end if;
end
$$;

alter table public.spas1_finance_transactions
  add column if not exists source_purchase_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spas1_finance_transactions'::regclass
      and conname = 'spas1_finance_transactions_source_purchase_fkey'
  ) then
    alter table public.spas1_finance_transactions
      add constraint spas1_finance_transactions_source_purchase_fkey
      foreign key (source_purchase_id)
      references public."modul3_stok_logistik_belanja_harian"("ID")
      on delete restrict;
  end if;
end
$$;

create unique index if not exists spas1_finance_purchase_source_key
  on public.spas1_finance_transactions (source_purchase_id)
  where source_purchase_id is not null;

create table if not exists public.spas1_finance_obligations (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  direction text not null check (direction in ('payable', 'receivable')),
  source_purchase_id uuid references public."modul3_stok_logistik_belanja_harian"("ID") on delete restrict,
  party_name text not null,
  description text not null,
  total_amount numeric(14,2) not null check (total_amount > 0),
  due_date date,
  status text not null default 'open' check (status in ('open', 'partial', 'settled', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  check (length(btrim(party_name)) between 1 and 160),
  check (length(btrim(description)) between 1 and 500),
  check (
    (direction = 'payable' and source_purchase_id is not null)
    or (direction = 'receivable' and source_purchase_id is null)
  )
);

create unique index if not exists spas1_finance_obligation_purchase_key
  on public.spas1_finance_obligations (source_purchase_id)
  where source_purchase_id is not null;
create index if not exists spas1_finance_obligations_tenant_status_idx
  on public.spas1_finance_obligations (sppg_id, direction, status, due_date);

alter table public.spas1_finance_transactions
  add column if not exists source_obligation_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spas1_finance_transactions'::regclass
      and conname = 'spas1_finance_transactions_source_obligation_fkey'
  ) then
    alter table public.spas1_finance_transactions
      add constraint spas1_finance_transactions_source_obligation_fkey
      foreign key (source_obligation_id)
      references public.spas1_finance_obligations(id)
      on delete restrict;
  end if;
end
$$;

create index if not exists spas1_finance_transactions_source_obligation_idx
  on public.spas1_finance_transactions (sppg_id, source_obligation_id)
  where source_obligation_id is not null;

create table if not exists public.spas1_finance_obligation_payments (
  id uuid primary key default gen_random_uuid(),
  sppg_id uuid not null references public.spas1_organizations(id) on delete cascade,
  obligation_id uuid not null references public.spas1_finance_obligations(id) on delete restrict,
  finance_transaction_id uuid not null unique references public.spas1_finance_transactions(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid()
);

create index if not exists spas1_finance_obligation_payments_parent_idx
  on public.spas1_finance_obligation_payments (sppg_id, obligation_id, created_at desc);

alter table public.spas1_finance_obligations enable row level security;
alter table public.spas1_finance_obligation_payments enable row level security;
revoke all on public.spas1_finance_obligations, public.spas1_finance_obligation_payments from public, anon;
grant select on public.spas1_finance_obligations, public.spas1_finance_obligation_payments to authenticated;

drop policy if exists "Finance obligations tenant admin read" on public.spas1_finance_obligations;
create policy "Finance obligations tenant admin read"
on public.spas1_finance_obligations for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Finance obligation payments tenant admin read" on public.spas1_finance_obligation_payments;
create policy "Finance obligation payments tenant admin read"
on public.spas1_finance_obligation_payments for select to authenticated
using (
  sppg_id = public.spas1_current_sppg_id()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create or replace function public.spas1_refresh_finance_obligation_status(p_obligation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_obligation public.spas1_finance_obligations%rowtype;
  v_paid numeric;
  v_status text;
begin
  select * into v_obligation
  from public.spas1_finance_obligations
  where id = p_obligation_id
  for update;
  if not found or v_obligation.status = 'cancelled' then return; end if;

  select coalesce(sum(payment.amount), 0) into v_paid
  from public.spas1_finance_obligation_payments as payment
  join public.spas1_finance_transactions as transaction
    on transaction.id = payment.finance_transaction_id
   and transaction.sppg_id = payment.sppg_id
  where payment.obligation_id = p_obligation_id
    and transaction.status = 'approved';

  v_status := case
    when v_paid >= v_obligation.total_amount then 'settled'
    when v_paid > 0 then 'partial'
    else 'open'
  end;
  update public.spas1_finance_obligations
  set status = v_status, updated_at = now()
  where id = p_obligation_id;

  if v_obligation.source_purchase_id is not null then
    update public."modul3_stok_logistik_belanja_harian"
    set "Status Pembayaran" = case v_status
      when 'settled' then 'Lunas'
      when 'partial' then 'Hutang Sebagian'
      else 'Hutang'
    end
    where "ID" = v_obligation.source_purchase_id
      and sppg_id = v_obligation.sppg_id
      and "Status" = 'Aktif';
  end if;
end;
$$;

create or replace function public.spas1_on_finance_obligation_payment_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_obligation_id uuid;
begin
  if old.status is distinct from new.status then
    select obligation_id into v_obligation_id
    from public.spas1_finance_obligation_payments
    where finance_transaction_id = new.id
      and sppg_id = new.sppg_id;
    if v_obligation_id is not null then
      perform public.spas1_refresh_finance_obligation_status(v_obligation_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists spas1_finance_obligation_payment_status on public.spas1_finance_transactions;
create trigger spas1_finance_obligation_payment_status
after update of status on public.spas1_finance_transactions
for each row execute function public.spas1_on_finance_obligation_payment_status();

create or replace function public.spas1_guard_purchase_finance_cancellation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_finance_status text;
begin
  if old."Status" = 'Aktif' and new."Status" = 'Dibatalkan' then
    select status into v_finance_status
    from public.spas1_finance_transactions
    where source_purchase_id = old."ID"
      and sppg_id = old.sppg_id
    for update;
    if v_finance_status = 'approved' then
      raise exception 'Nota pembelian sudah masuk saldo dan tidak dapat dibatalkan. Catat koreksi keuangan terlebih dahulu.';
    end if;
    if exists (
      select 1
      from public.spas1_finance_obligations as obligation
      join public.spas1_finance_obligation_payments as payment
        on payment.obligation_id = obligation.id
       and payment.sppg_id = obligation.sppg_id
      join public.spas1_finance_transactions as transaction
        on transaction.id = payment.finance_transaction_id
       and transaction.sppg_id = payment.sppg_id
      where obligation.source_purchase_id = old."ID"
        and obligation.sppg_id = old.sppg_id
        and transaction.status in ('pending', 'approved')
    ) then
      raise exception 'Pembayaran Hutang nota ini sedang diproses atau sudah disetujui; selesaikan atau tolak pembayaran sebelum membatalkan nota.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.spas1_cancel_purchase_finance_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transaction public.spas1_finance_transactions%rowtype;
  v_before jsonb;
begin
  if old."Status" = 'Aktif' and new."Status" = 'Dibatalkan' then
    for v_transaction in
      select * from public.spas1_finance_transactions
      where source_purchase_id = old."ID"
        and sppg_id = old.sppg_id
        and status = 'pending'
      for update
    loop
      v_before := to_jsonb(v_transaction);
      update public.spas1_finance_transactions
      set status = 'rejected',
          rejected_at = now(),
          rejected_by = auth.uid(),
          rejection_reason = left('Nota pembelian dibatalkan: ' || coalesce(new."Alasan Pembatalan", 'tanpa keterangan'), 500),
          updated_at = now()
      where id = v_transaction.id
        and sppg_id = old.sppg_id
      returning *
      into v_transaction;
      insert into public.spas1_finance_transaction_audit (
        sppg_id, transaction_id, action, before_data, after_data
      ) values (
        v_transaction.sppg_id,
        v_transaction.id,
        'rejected',
        v_before,
        to_jsonb(v_transaction)
      );
    end loop;

    update public.spas1_finance_obligations
    set status = 'cancelled', updated_at = now()
    where source_purchase_id = old."ID"
      and sppg_id = old.sppg_id
      and status = 'open';

    update public."modul3_stok_logistik_belanja_harian"
    set "Status Pembayaran" = 'Dibatalkan'
    where "ID" = old."ID" and sppg_id = old.sppg_id;
  end if;
  return new;
end;
$$;

drop trigger if exists spas1_purchase_finance_cancel_guard on public."modul3_stok_logistik_belanja_harian";
create trigger spas1_purchase_finance_cancel_guard
before update of "Status" on public."modul3_stok_logistik_belanja_harian"
for each row execute function public.spas1_guard_purchase_finance_cancellation();

drop trigger if exists spas1_purchase_finance_cancel_links on public."modul3_stok_logistik_belanja_harian";
create trigger spas1_purchase_finance_cancel_links
after update of "Status" on public."modul3_stok_logistik_belanja_harian"
for each row execute function public.spas1_cancel_purchase_finance_links();

create or replace function public.spas1_guard_linked_finance_transaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.source_purchase_id is not null or old.source_obligation_id is not null or exists (
      select 1 from public.spas1_finance_obligation_payments
      where finance_transaction_id = old.id
    ) then
      raise exception 'Transaksi yang terhubung ke nota atau Hutang/Piutang tidak dapat dihapus terpisah.';
    end if;
    return old;
  end if;

  if (old.source_purchase_id is not null or old.source_obligation_id is not null or exists (
        select 1 from public.spas1_finance_obligation_payments
        where finance_transaction_id = old.id
      ))
     then
    if row(
         new.transaction_type, new.transaction_date, new.category, new.description,
         new.amount, new.payment_method, new.reference, new.receipt_path,
         new.source_purchase_id, new.source_obligation_id
       ) is distinct from row(
         old.transaction_type, old.transaction_date, old.category, old.description,
         old.amount, old.payment_method, old.reference, old.receipt_path,
         old.source_purchase_id, old.source_obligation_id
       )
       or (old.status is distinct from new.status
           and not (old.status = 'pending' and new.status in ('approved', 'rejected'))) then
      raise exception 'Transaksi nota atau pembayaran Hutang/Piutang tidak dapat diedit langsung; gunakan alur nota atau kewajiban.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists spas1_finance_linked_transaction_guard on public.spas1_finance_transactions;
create trigger spas1_finance_linked_transaction_guard
before update or delete on public.spas1_finance_transactions
for each row execute function public.spas1_guard_linked_finance_transaction();

create or replace function public.spas1_attach_purchase_payment(
  p_purchase_id uuid,
  p_payment_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_report public."modul3_stok_logistik_belanja_harian"%rowtype;
  v_transaction_id uuid;
  v_amount numeric;
begin
  if not public.spas1_has_module_access('stok') then
    raise exception 'Akses Modul Stok diperlukan untuk menyimpan nota pembelian.';
  end if;
  if v_sppg_id is null or p_purchase_id is null or p_payment_type is null
     or p_payment_type not in ('cash_lunas', 'hutang', 'legacy') then
    raise exception 'Metode pembayaran nota tidak valid.';
  end if;
  select * into v_report
  from public."modul3_stok_logistik_belanja_harian"
  where "ID" = p_purchase_id and sppg_id = v_sppg_id and "Status" = 'Aktif'
  for update;
  if not found then raise exception 'Nota pembelian tidak ditemukan atau sudah dibatalkan.'; end if;

  v_amount := round(v_report."Total Belanja", 2);
  if v_amount <= 0 or v_amount > 999999999999.99 then
    raise exception 'Total nota harus lebih dari Rp 0 dan tidak melebihi batas pencatatan keuangan.';
  end if;

  if p_payment_type = 'legacy' then
    if exists (
      select 1 from public.spas1_finance_transactions
      where source_purchase_id = p_purchase_id and sppg_id = v_sppg_id
    ) or exists (
      select 1 from public.spas1_finance_obligations
      where source_purchase_id = p_purchase_id and sppg_id = v_sppg_id
    ) then
      raise exception 'Nota yang sudah terhubung ke saldo atau Hutang tidak dapat diubah menjadi data lama.';
    end if;
    update public."modul3_stok_logistik_belanja_harian"
    set "Status Pembayaran" = 'Belum Dicatat'
    where "ID" = p_purchase_id and sppg_id = v_sppg_id;
    return jsonb_build_object('paymentType', 'legacy');
  end if;

  if p_payment_type = 'cash_lunas' then
    update public."modul3_stok_logistik_belanja_harian"
    set "Status Pembayaran" = 'Cash/Lunas'
    where "ID" = p_purchase_id and sppg_id = v_sppg_id;

    insert into public.spas1_finance_transactions (
      sppg_id, transaction_type, transaction_date, category, description,
      amount, payment_method, reference, receipt_path, source_purchase_id, status
    ) values (
      v_sppg_id,
      'pengeluaran',
      v_report."Tanggal"::date,
      'Pembelian Stok',
      'Pembelian ' || v_report."Nomor PO" || ' - ' || v_report."Supplier",
      v_amount,
      'Cash/Lunas',
      v_report."Nomor PO",
      v_report."Foto Path",
      p_purchase_id,
      'pending'
    ) returning id into v_transaction_id;

    return jsonb_build_object('paymentType', 'cash_lunas', 'financeTransactionId', v_transaction_id);
  end if;

  insert into public.spas1_finance_obligations (
    sppg_id, direction, source_purchase_id, party_name, description, total_amount
  ) values (
    v_sppg_id, 'payable', p_purchase_id, v_report."Supplier",
    'Nota pembelian ' || v_report."Nomor PO", v_amount
  );
  update public."modul3_stok_logistik_belanja_harian"
  set "Status Pembayaran" = 'Hutang'
  where "ID" = p_purchase_id and sppg_id = v_sppg_id;
  return jsonb_build_object('paymentType', 'hutang');
end;
$$;

create or replace function public.spas1_record_stock_purchase_with_payment(
  p_purchase_date date,
  p_po_number text,
  p_supplier_id uuid,
  p_note text,
  p_location text,
  p_photo_path text,
  p_items jsonb,
  p_payment_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_purchase_id uuid;
  v_payment jsonb;
begin
  if p_payment_type is null or p_payment_type not in ('cash_lunas', 'hutang') then
    raise exception 'Pilih pembayaran Cash/Lunas atau Hutang.';
  end if;
  v_result := public.record_stok_logistik_purchase_order(
    p_purchase_date, p_po_number, p_supplier_id, p_note, p_location, p_photo_path, p_items
  );
  v_purchase_id := (v_result -> 'report' ->> 'ID')::uuid;
  v_payment := public.spas1_attach_purchase_payment(v_purchase_id, p_payment_type);
  return v_result || jsonb_build_object('payment', v_payment);
end;
$$;

create or replace function public.spas1_edit_stock_purchase_with_payment(
  p_purchase_id uuid,
  p_purchase_date date,
  p_po_number text,
  p_supplier_id uuid,
  p_note text,
  p_location text,
  p_photo_path text,
  p_items jsonb,
  p_payment_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_new_purchase_id uuid;
  v_payment jsonb;
  v_original_report public."modul3_stok_logistik_belanja_harian"%rowtype;
begin
  if p_payment_type is null or p_payment_type not in ('cash_lunas', 'hutang', 'legacy') then
    raise exception 'Pilih pembayaran Cash/Lunas atau Hutang.';
  end if;
  if p_payment_type = 'legacy' then
    select * into v_original_report
    from public."modul3_stok_logistik_belanja_harian"
    where "ID" = p_purchase_id
      and sppg_id = public.spas1_current_sppg_id()
      and "Status" = 'Aktif'
    for update;
    if not found or v_original_report."Status Pembayaran" <> 'Belum Dicatat' then
      raise exception 'Status lama tanpa pencatatan saldo hanya berlaku pada nota lama yang memang belum diselaraskan.';
    end if;
  end if;
  v_result := public.edit_stok_logistik_purchase_order(
    p_purchase_id, p_purchase_date, p_po_number, p_supplier_id,
    p_note, p_location, p_photo_path, p_items
  );
  v_new_purchase_id := (v_result -> 'purchase' -> 'report' ->> 'ID')::uuid;
  v_payment := public.spas1_attach_purchase_payment(v_new_purchase_id, p_payment_type);
  return v_result || jsonb_build_object('payment', v_payment);
end;
$$;

create or replace function public.spas1_create_finance_receivable(
  p_party_name text,
  p_description text,
  p_amount numeric,
  p_due_date date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sppg_id uuid := public.spas1_current_sppg_id();
  v_obligation public.spas1_finance_obligations%rowtype;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat mencatat Piutang.';
  end if;
  if v_sppg_id is null
     or nullif(btrim(p_party_name), '') is null or length(p_party_name) > 160
     or nullif(btrim(p_description), '') is null or length(p_description) > 500
     or p_amount is null or p_amount <= 0 or p_amount > 999999999999.99
     or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <> round(p_amount, 2) then
    raise exception 'Nama pihak, keterangan, dan nilai Piutang harus valid.';
  end if;
  insert into public.spas1_finance_obligations (
    sppg_id, direction, party_name, description, total_amount, due_date
  ) values (
    v_sppg_id, 'receivable', btrim(p_party_name), btrim(p_description), p_amount, p_due_date
  ) returning * into v_obligation;
  return jsonb_build_object('id', v_obligation.id, 'status', v_obligation.status);
end;
$$;

create or replace function public.spas1_record_finance_obligation_payment(
  p_obligation_id uuid,
  p_transaction_date date,
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
  v_obligation public.spas1_finance_obligations%rowtype;
  v_transaction public.spas1_finance_transactions%rowtype;
  v_reserved numeric;
  v_type text;
  v_category text;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'Hanya SUPER ADMIN yang dapat mencatat pembayaran Hutang/Piutang.';
  end if;
  if v_sppg_id is null or p_obligation_id is null
     or p_transaction_date is null
     or p_transaction_date > (now() at time zone 'Asia/Jakarta')::date
     or p_amount is null or p_amount <= 0 or p_amount > 999999999999.99
     or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <> round(p_amount, 2)
     or nullif(btrim(p_payment_method), '') is null or length(p_payment_method) > 100
     or length(coalesce(p_reference, '')) > 160
     or p_receipt_path is null
     or split_part(p_receipt_path, '/', 1) <> public.spas1_current_storage_folder()
     or p_receipt_path !~ '^[a-z0-9-]+/akuntan-keuangan/[^/]+\.(jpeg|png|webp)$' then
    raise exception 'Tanggal, nominal, metode, referensi, atau bukti pembayaran tidak valid.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_sppg_id::text, 0));
  select * into v_obligation
  from public.spas1_finance_obligations
  where id = p_obligation_id and sppg_id = v_sppg_id
  for update;
  if not found or v_obligation.status = 'cancelled' then
    raise exception 'Hutang/Piutang tidak ditemukan atau sudah dibatalkan.';
  end if;

  select coalesce(sum(payment.amount), 0) into v_reserved
  from public.spas1_finance_obligation_payments as payment
  join public.spas1_finance_transactions as transaction
    on transaction.id = payment.finance_transaction_id
   and transaction.sppg_id = payment.sppg_id
  where payment.obligation_id = p_obligation_id
    and transaction.status in ('pending', 'approved');
  if round(v_reserved + p_amount, 2) > v_obligation.total_amount then
    raise exception 'Nominal pembayaran melebihi sisa Hutang/Piutang yang belum disetujui.';
  end if;

  v_type := case when v_obligation.direction = 'payable' then 'pengeluaran' else 'pemasukan' end;
  v_category := case when v_obligation.direction = 'payable' then 'Pembayaran Hutang Supplier' else 'Penerimaan Piutang' end;
  insert into public.spas1_finance_transactions (
    sppg_id, transaction_type, transaction_date, category, description,
    amount, payment_method, reference, receipt_path, source_obligation_id, status
  ) values (
    v_sppg_id, v_type, p_transaction_date, v_category,
    case when v_obligation.direction = 'payable' then 'Pembayaran Hutang: ' else 'Penerimaan Piutang: ' end ||
      v_obligation.party_name || ' - ' || v_obligation.description,
    p_amount, btrim(p_payment_method), btrim(coalesce(p_reference, '')), p_receipt_path,
    p_obligation_id, 'pending'
  ) returning * into v_transaction;

  insert into public.spas1_finance_obligation_payments (
    sppg_id, obligation_id, finance_transaction_id, amount
  ) values (v_sppg_id, p_obligation_id, v_transaction.id, p_amount);
  return jsonb_build_object('id', v_transaction.id, 'status', v_transaction.status);
end;
$$;

revoke all on function public.spas1_refresh_finance_obligation_status(uuid) from public, anon;
revoke all on function public.spas1_on_finance_obligation_payment_status() from public, anon;
revoke all on function public.spas1_guard_purchase_finance_cancellation() from public, anon;
revoke all on function public.spas1_cancel_purchase_finance_links() from public, anon;
revoke all on function public.spas1_guard_linked_finance_transaction() from public, anon;
revoke all on function public.spas1_attach_purchase_payment(uuid, text) from public, anon;
revoke all on function public.spas1_record_stock_purchase_with_payment(date, text, uuid, text, text, text, jsonb, text) from public, anon;
revoke all on function public.spas1_edit_stock_purchase_with_payment(uuid, date, text, uuid, text, text, text, jsonb, text) from public, anon;
revoke all on function public.spas1_create_finance_receivable(text, text, numeric, date) from public, anon;
revoke all on function public.spas1_record_finance_obligation_payment(uuid, date, numeric, text, text, text) from public, anon;

grant execute on function public.spas1_record_stock_purchase_with_payment(date, text, uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.spas1_edit_stock_purchase_with_payment(uuid, date, text, uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.spas1_create_finance_receivable(text, text, numeric, date) to authenticated;
grant execute on function public.spas1_record_finance_obligation_payment(uuid, date, numeric, text, text, text) to authenticated;
