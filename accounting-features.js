function initializeStockOpnameDate() {
  const input = document.getElementById('stockOpnameDate');
  if (input && !input.value) input.value = localDateInputValue();
}

function resetStockOpnameForm() {
  stockOpnameEditingId = '';
  document.getElementById('stockOpnameDate').value = localDateInputValue();
  document.getElementById('stockOpnameNote').value = '';
  stockOpnameRows = [];
  document.getElementById('stockOpnameItems').innerHTML = '<tr><td colspan="6" class="p-5 text-center text-gray-500">Muat item stok untuk memulai opname.</td></tr>';
  document.getElementById('stockOpnameStatus').textContent = 'Form opname baru.';
  document.getElementById('stockOpnameSaveDraft').disabled = false;
  document.getElementById('stockOpnameSubmit').disabled = false;
}

function renderStockOpnameItems(rows) {
  const tbody = document.getElementById('stockOpnameItems');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-5 text-center text-gray-500">Belum ada item stok pada SPPG ini.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function(row) {
    const countValue = row.counted_quantity == null ? '' : String(row.counted_quantity);
    const difference = row.counted_quantity == null ? '—' : Number(row.counted_quantity) - Number(row.expected_quantity);
    const differenceText = row.counted_quantity == null ? '—' : (difference > 0 ? '+' : '') + difference;
    return '<tr class="border-t border-gray-100">' +
      '<td class="p-3 font-semibold">' + escapeHtml(row.item_name) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.category) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.unit) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.expected_quantity) + '</td>' +
      '<td class="p-3"><input type="number" min="0" max="999999999999.999" step="0.001" aria-label="Jumlah fisik ' + escapeHtml(row.item_name) + '" data-opname-item="' + escapeHtml(row.item_id) + '" value="' + escapeHtml(countValue) + '" class="w-28 rounded border border-gray-300 p-2" oninput="updateStockOpnameDifference(this)"></td>' +
      '<td class="p-3 font-bold" data-opname-difference="' + escapeHtml(row.item_id) + '">' + escapeHtml(differenceText) + '</td>' +
    '</tr>';
  }).join('');
}

function updateStockOpnameDifference(input) {
  const row = stockOpnameRows.find(function(item) { return item.item_id === input.dataset.opnameItem; });
  const cell = Array.from(document.querySelectorAll('[data-opname-difference]')).find(function(element) {
    return element.dataset.opnameDifference === input.dataset.opnameItem;
  });
  if (!row || !cell) return;
  if (input.value === '') {
    cell.textContent = '—';
    return;
  }
  const difference = Number(input.value) - Number(row.expected_quantity);
  cell.textContent = (difference > 0 ? '+' : '') + difference;
}

async function fetchAccountingRows(table, query) {
  const pageSize = 500;
  const maximumRows = 50000;
  let offset = 0;
  const rows = [];
  while (offset < maximumRows) {
    const page = await supabaseRequest(table, {
      query: Object.assign({}, query, { limit: String(pageSize), offset: String(offset) })
    });
    if (!Array.isArray(page)) throw new Error('Respons data ' + table + ' tidak valid.');
    rows.push.apply(rows, page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
  throw new Error('Data melebihi batas aman pemuatan. Gunakan filter tanggal yang lebih sempit.');
}

async function loadStockOpnameInventory(existingLines) {
  const status = document.getElementById('stockOpnameStatus');
  status.textContent = 'Memuat daftar stok...';
  try {
    const result = await fetchAccountingRows('modul3_stok_logistik', { select: '*', order: '"Nama Item".asc,ID.asc' });
    stockOpnameItems = Array.isArray(result) ? result : [];
    const byId = new Map((existingLines || []).map(function(line) { return [String(line.item_id), line]; }));
    stockOpnameRows = stockOpnameItems.map(function(item) {
      const itemId = String(item.ID);
      const existing = byId.get(itemId);
      return {
        item_id: itemId,
        item_name: String(item['Nama Item'] || ''),
        category: String(item.Kategori || ''),
        unit: String(item.Satuan || ''),
        expected_quantity: existing ? Number(existing.expected_quantity) : Number(item.Stok) || 0,
        counted_quantity: existing ? existing.counted_quantity : null
      };
    }).sort(function(left, right) { return left.item_name.localeCompare(right.item_name, 'id'); });
    renderStockOpnameItems(stockOpnameRows);
    status.textContent = stockOpnameRows.length + ' item dimuat. Isi jumlah fisik setiap item.';
    return stockOpnameRows;
  } catch (error) {
    status.textContent = 'Gagal memuat stok: ' + error.message;
    showToast('❌ Gagal memuat stok untuk opname: ' + error.message);
    throw error;
  }
}

async function saveStockOpname(submit) {
  const status = document.getElementById('stockOpnameStatus');
  const saveButton = document.getElementById(submit ? 'stockOpnameSubmit' : 'stockOpnameSaveDraft');
  if (saveButton.disabled) return;
  try {
    if (!stockOpnameRows.length) await loadStockOpnameInventory();
    const lines = Array.from(document.querySelectorAll('#stockOpnameItems [data-opname-item]')).map(function(input) {
      return { item_id: input.dataset.opnameItem, counted_quantity: input.value === '' ? null : Number(input.value) };
    });
    if (!lines.length) throw new Error('Daftar item stok kosong. Muat ulang item stok.');
    if (submit && lines.some(function(line) { return line.counted_quantity === null || !Number.isFinite(line.counted_quantity); })) {
      throw new Error('Isi jumlah fisik untuk semua item sebelum mengajukan opname.');
    }
    saveButton.disabled = true;
    status.textContent = submit ? 'Mengajukan opname...' : 'Menyimpan draft...';
    const result = await supabaseRpc('spas1_save_stock_opname', {
      p_opname_id: stockOpnameEditingId || null,
      p_opname_date: document.getElementById('stockOpnameDate').value,
      p_note: document.getElementById('stockOpnameNote').value.trim(),
      p_lines: lines,
      p_submit: Boolean(submit)
    });
    stockOpnameEditingId = submit ? '' : result.id;
    status.textContent = submit ? 'Opname berhasil diajukan dan menunggu persetujuan SUPER ADMIN.' : 'Draft opname tersimpan.';
    showToast(submit ? '✅ Opname diajukan untuk persetujuan.' : '✅ Draft opname tersimpan.');
    if (submit) resetStockOpnameForm();
    await loadStockOpnames();
  } catch (error) {
    status.textContent = 'Gagal menyimpan opname: ' + error.message;
    showToast('❌ Gagal menyimpan opname: ' + error.message);
  } finally {
    saveButton.disabled = false;
  }
}

async function loadStockOpnames() {
  const tbody = document.getElementById('stockOpnameRows');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="p-5 text-center text-gray-500">Memuat riwayat...</td></tr>';
  try {
    const headers = await fetchAccountingRows('spas1_stock_opnames', { select: '*', order: 'opname_date.desc,created_at.desc,id.desc' });
    tbody.innerHTML = headers.length ? headers.map(function(row) {
      const actions = ['draft', 'rejected'].includes(row.status)
        ? '<button type="button" class="mr-1 rounded bg-slate-600 px-2 py-1 text-white" onclick="editStockOpname(\'' + escapeHtml(row.id) + '\')">Lanjutkan</button>'
        : '';
      const review = row.status === 'pending'
        ? '<button type="button" class="mr-1 rounded bg-emerald-600 px-2 py-1 text-white" onclick="approveStockOpname(\'' + escapeHtml(row.id) + '\')">Setujui</button><button type="button" class="rounded bg-rose-600 px-2 py-1 text-white" onclick="rejectStockOpname(\'' + escapeHtml(row.id) + '\')">Tolak</button>'
        : '';
      return '<tr class="border-t border-gray-100"><td class="p-3">' + escapeHtml(row.opname_date) + '</td>' +
        '<td class="p-3">' + escapeHtml(String(row.created_at || '').slice(0, 10)) + '</td>' +
        '<td class="p-3 font-bold">' + escapeHtml(stockOpnameStatusLabel(row.status)) + '</td>' +
        '<td class="max-w-xs truncate p-3" title="' + escapeHtml(row.note || row.rejection_reason || '') + '">' + escapeHtml(row.rejection_reason || row.note || '—') + '</td>' +
        '<td class="p-3"><button type="button" class="mr-1 rounded border border-gray-300 px-2 py-1" onclick="showStockOpnameDetails(\'' + escapeHtml(row.id) + '\')">Detail</button>' + actions + review + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="p-5 text-center text-gray-500">Belum ada riwayat opname.</td></tr>';
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-5 text-center text-rose-700">Gagal memuat opname: ' + escapeHtml(error.message) + '</td></tr>';
    showToast('❌ Gagal memuat riwayat opname: ' + error.message);
  }
}

function stockOpnameStatusLabel(status) {
  return { draft: 'Draft', pending: 'Menunggu persetujuan', approved: 'Disetujui', rejected: 'Ditolak' }[status] || status;
}

async function editStockOpname(id) {
  try {
    const results = await Promise.all([
      supabaseRequest('spas1_stock_opnames', { query: { select: '*', id: 'eq.' + id, limit: '1' } }),
      supabaseRequest('spas1_stock_opname_lines', { query: { select: '*', opname_id: 'eq.' + id, order: 'item_name.asc' } })
    ]);
    const opname = Array.isArray(results[0]) ? results[0][0] : null;
    if (!opname || !['draft', 'rejected'].includes(opname.status)) throw new Error('Opname tidak dapat dilanjutkan.');
    stockOpnameEditingId = opname.id;
    document.getElementById('stockOpnameDate').value = opname.opname_date;
    document.getElementById('stockOpnameNote').value = opname.note || '';
    await loadStockOpnameInventory(Array.isArray(results[1]) ? results[1] : []);
    document.getElementById('stockOpnameStatus').textContent = 'Melanjutkan draft opname ' + opname.opname_date + '.';
    document.getElementById('stockOpnameItems').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    showToast('❌ Gagal membuka opname: ' + error.message);
  }
}

async function showStockOpnameDetails(id) {
  const detail = document.getElementById('stockOpnameDetail');
  detail.classList.remove('hidden');
  detail.textContent = 'Memuat rincian opname...';
  try {
    const rows = await supabaseRequest('spas1_stock_opname_lines', { query: { select: '*', opname_id: 'eq.' + id, order: 'item_name.asc' } });
    detail.innerHTML = '<h4 class="mb-2 font-bold">Rincian Opname</h4><div class="overflow-x-auto"><table class="w-full min-w-[600px] text-left text-xs"><thead><tr><th class="p-2">Item</th><th class="p-2">Sistem</th><th class="p-2">Fisik</th><th class="p-2">Selisih</th></tr></thead><tbody>' +
      (Array.isArray(rows) ? rows : []).map(function(row) {
        const difference = row.difference == null ? 'Belum dihitung' : (Number(row.difference) > 0 ? '+' : '') + row.difference;
        return '<tr class="border-t"><td class="p-2">' + escapeHtml(row.item_name) + '</td><td class="p-2">' + escapeHtml(row.expected_quantity) + ' ' + escapeHtml(row.unit) + '</td><td class="p-2">' + escapeHtml(row.counted_quantity == null ? '—' : row.counted_quantity) + '</td><td class="p-2">' + escapeHtml(difference) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  } catch (error) {
    detail.textContent = 'Gagal memuat detail: ' + error.message;
  }
}

async function approveStockOpname(id) {
  if (!window.confirm('Setujui opname ini dan terapkan semua selisih ke stok?')) return;
  try {
    const result = await supabaseRpc('spas1_approve_stock_opname', { p_opname_id: id });
    showToast('✅ Opname disetujui. ' + Number(result.adjustments || 0) + ' penyesuaian stok dicatat.');
    await Promise.all([loadStockOpnames(), loadStockMovements()]);
  } catch (error) {
    showToast('❌ Gagal menyetujui opname: ' + error.message);
  }
}

async function rejectStockOpname(id) {
  const reason = window.prompt('Alasan penolakan opname:');
  if (reason === null) return;
  try {
    await supabaseRpc('spas1_reject_stock_opname', { p_opname_id: id, p_reason: reason.trim() });
    showToast('✅ Opname ditolak dengan alasan tercatat.');
    await loadStockOpnames();
  } catch (error) {
    showToast('❌ Gagal menolak opname: ' + error.message);
  }
}

function initializeFinanceDate() {
  const date = document.getElementById('financeTransactionDate');
  if (date && !date.value) date.value = localDateInputValue();
  const from = document.getElementById('financeFilterFrom');
  const to = document.getElementById('financeFilterTo');
  if (from && !from.value) from.value = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  if (to && !to.value) to.value = localDateInputValue();
}

function formatFinanceMoney(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function financeTypeLabel(type) {
  return { saldo_awal: 'Saldo Awal', pemasukan: 'Pemasukan', pengeluaran: 'Pengeluaran' }[type] || type;
}

function financeStatusLabel(status) {
  return { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' }[status] || status;
}

function getFilteredFinanceTransactions() {
  const from = document.getElementById('financeFilterFrom').value;
  const to = document.getElementById('financeFilterTo').value;
  const type = document.getElementById('financeFilterType').value;
  const status = document.getElementById('financeFilterStatus').value;
  return financeTransactions.filter(function(row) {
    return (!from || row.transaction_date >= from) && (!to || row.transaction_date <= to) &&
      (!type || row.transaction_type === type) && (!status || row.status === status);
  });
}

async function loadFinanceTransactions() {
  const tbody = document.getElementById('financeTransactionRows');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="p-5 text-center text-gray-500">Memuat transaksi...</td></tr>';
  try {
    const rows = await fetchAccountingRows('spas1_finance_transactions', { select: '*', order: 'transaction_date.desc,created_at.desc,id.desc' });
    financeTransactions = Array.isArray(rows) ? rows : [];
    const approved = financeTransactions.filter(function(row) { return row.status === 'approved'; });
    const openingBalance = approved.filter(function(row) { return row.transaction_type === 'saldo_awal'; })
      .reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
    const income = approved.filter(function(row) { return row.transaction_type === 'pemasukan'; })
      .reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
    const expense = approved.filter(function(row) { return row.transaction_type === 'pengeluaran'; })
      .reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
    document.getElementById('financeCurrentBalance').textContent = formatFinanceMoney(openingBalance + income - expense);
    document.getElementById('financeOpeningBalance').textContent = formatFinanceMoney(openingBalance);
    document.getElementById('financeTotalIncome').textContent = formatFinanceMoney(income);
    document.getElementById('financeTotalExpense').textContent = formatFinanceMoney(expense);
    renderFinanceTransactions();
    document.getElementById('financeStatus').textContent = financeTransactions.length + ' transaksi dimuat. Pengeluaran hanya dapat disetujui jika saldo mencukupi.';
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="9" class="p-5 text-center text-rose-700">Gagal memuat transaksi: ' + escapeHtml(error.message) + '</td></tr>';
    document.getElementById('financeStatus').textContent = 'Jalankan accounting_inventory_finance_migration.sql di Supabase jika tabel belum tersedia.';
    showToast('❌ Gagal memuat transaksi keuangan: ' + error.message);
  }
}

function renderFinanceTransactions() {
  const tbody = document.getElementById('financeTransactionRows');
  const rows = getFilteredFinanceTransactions();
  tbody.innerHTML = rows.length ? rows.map(function(row) {
    const receipt = row.receipt_path
      ? '<button type="button" class="text-indigo-700 underline" data-receipt-path="' + escapeHtml(row.receipt_path) + '" onclick="openFinanceReceipt(this)">Lihat foto</button>'
      : '—';
    const review = row.status === 'pending'
      ? '<button type="button" class="mb-1 mr-1 rounded bg-emerald-600 px-2 py-1 text-white" onclick="approveFinanceTransaction(\'' + escapeHtml(row.id) + '\')">Setujui</button><button type="button" class="mb-1 rounded bg-rose-600 px-2 py-1 text-white" onclick="rejectFinanceTransaction(\'' + escapeHtml(row.id) + '\')">Tolak</button>'
      : '';
    return '<tr class="border-t border-gray-100"><td class="p-3">' + escapeHtml(row.transaction_date) + '</td>' +
      '<td class="p-3">' + escapeHtml(financeTypeLabel(row.transaction_type)) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.category) + '</td>' +
      '<td class="finance-description-cell p-3">' + escapeHtml(row.description) + '</td>' +
      '<td class="whitespace-nowrap p-3 font-bold">' + escapeHtml(formatFinanceMoney(row.amount)) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.payment_method) + '</td>' +
      '<td class="p-3">' + escapeHtml(row.reference || '—') + '<div>' + receipt + '</div></td>' +
      '<td class="p-3">' + escapeHtml(financeStatusLabel(row.status)) + (row.rejection_reason ? '<div class="text-rose-700">' + escapeHtml(row.rejection_reason) + '</div>' : '') + '</td>' +
      '<td class="p-3 no-print">' + review + '<button type="button" class="mb-1 mr-1 rounded border border-gray-300 px-2 py-1" onclick="editFinanceTransaction(\'' + escapeHtml(row.id) + '\')">Edit</button><button type="button" class="rounded bg-rose-700 px-2 py-1 text-white" onclick="deleteFinanceTransaction(\'' + escapeHtml(row.id) + '\')">Hapus</button></td></tr>';
  }).join('') : '<tr><td colspan="9" class="p-5 text-center text-gray-500">Tidak ada transaksi sesuai filter.</td></tr>';
}

async function loadFinanceAudit() {
  const tbody = document.getElementById('financeAuditRows');
  const status = document.getElementById('financeAuditStatus');
  tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">Memuat audit...</td></tr>';
  try {
    const rows = await fetchAccountingRows('spas1_finance_transaction_audit', {
      select: 'id,transaction_id,action,before_data,after_data,changed_at,changed_by',
      order: 'changed_at.desc,id.desc'
    });
    tbody.innerHTML = rows.length ? rows.map(function(row) {
      const details = JSON.stringify({ sebelum: row.before_data, sesudah: row.after_data }, null, 2);
      return '<tr class="border-t border-gray-100"><td class="whitespace-nowrap p-3">' + escapeHtml(row.changed_at) + '</td>' +
        '<td class="p-3">' + escapeHtml({ updated: 'Diubah', approved: 'Disetujui', rejected: 'Ditolak', deleted: 'Dihapus' }[row.action] || row.action) + '</td>' +
        '<td class="p-3 font-mono">' + escapeHtml(row.transaction_id) + '</td>' +
        '<td class="p-3 font-mono">' + escapeHtml(row.changed_by) + '</td>' +
        '<td class="p-3"><details><summary class="cursor-pointer text-indigo-700">Lihat data</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-[10px]">' + escapeHtml(details) + '</pre></details></td></tr>';
    }).join('') : '<tr><td colspan="5" class="p-4 text-center text-gray-500">Belum ada perubahan transaksi.</td></tr>';
    status.textContent = rows.length + ' peristiwa audit dimuat.';
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-rose-700">Gagal memuat audit: ' + escapeHtml(error.message) + '</td></tr>';
    status.textContent = 'Audit keuangan tidak dapat dimuat.';
    showToast('❌ Gagal memuat audit keuangan: ' + error.message);
  }
}

function resetFinanceForm() {
  const form = document.getElementById('financeTransactionForm');
  if (form) form.reset();
  document.getElementById('financeTransactionId').value = '';
  document.getElementById('financeReceiptPath').value = '';
  document.getElementById('financeTransactionDate').value = localDateInputValue();
  financeEditingReceiptPath = '';
  document.getElementById('financeReceiptHint').textContent = 'Wajib untuk pemasukan/pengeluaran; saldo awal boleh tanpa foto. Maksimum 10 MB.';
}

async function uploadFinanceReceipt(file) {
  if (!file || file.size > 10 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    throw new Error('Bukti harus berupa JPEG, PNG, atau WebP dengan ukuran maksimal 10 MB.');
  }
  const extension = file.type.split('/')[1];
  const path = getSupabaseTenantStorageFolder() + '/akuntan-keuangan/' +
    Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + extension;
  await supabaseStorageRequest('/storage/v1/object/spas1-finance/' + path.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'x-upsert': 'false' },
    body: file
  });
  return path;
}

async function saveFinanceTransaction(event) {
  event.preventDefault();
  const button = document.getElementById('financeSaveButton');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const type = document.getElementById('financeTransactionType').value;
    const file = document.getElementById('financeReceipt').files[0];
    let receiptPath = financeEditingReceiptPath || null;
    if (file) {
      receiptPath = await uploadFinanceReceipt(file);
    } else if (type !== 'saldo_awal' && !receiptPath) {
      throw new Error('Foto bukti wajib untuk pemasukan dan pengeluaran.');
    }
    await supabaseRpc('spas1_save_finance_transaction', {
      p_transaction_id: document.getElementById('financeTransactionId').value || null,
      p_transaction_type: type,
      p_transaction_date: document.getElementById('financeTransactionDate').value,
      p_category: document.getElementById('financeCategory').value.trim(),
      p_description: document.getElementById('financeDescription').value.trim(),
      p_amount: Number(document.getElementById('financeAmount').value),
      p_payment_method: document.getElementById('financePaymentMethod').value.trim(),
      p_reference: document.getElementById('financeReference').value.trim(),
      p_receipt_path: receiptPath
    });
    showToast('✅ Transaksi disimpan dan menunggu persetujuan SUPER ADMIN.');
    resetFinanceForm();
    await loadFinanceTransactions();
  } catch (error) {
    showToast('❌ Gagal menyimpan transaksi: ' + error.message);
  } finally {
    button.disabled = false;
  }
}

async function openFinanceReceipt(button) {
  const path = String(button.dataset.receiptPath || '');
  if (!isSupabaseTenantStoragePath(path, 'akuntan-keuangan/')) {
    showToast('❌ Lokasi bukti transaksi tidak valid.');
    return;
  }
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    showToast('Izinkan pop-up untuk membuka bukti transaksi.');
    return;
  }
  popup.opener = null;
  try {
    const response = await supabaseStorageRequest('/storage/v1/object/authenticated/spas1-finance/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'GET' });
    await openSupabaseMediaBlobInPopup(response, popup);
  } catch (error) {
    popup.close();
    showToast('❌ Gagal membuka bukti transaksi: ' + error.message);
  }
}

function editFinanceTransaction(id) {
  const row = financeTransactions.find(function(item) { return item.id === id; });
  if (!row) {
    showToast('❌ Transaksi tidak ditemukan.');
    return;
  }
  document.getElementById('financeTransactionId').value = row.id;
  document.getElementById('financeTransactionType').value = row.transaction_type;
  document.getElementById('financeTransactionDate').value = row.transaction_date;
  document.getElementById('financeCategory').value = row.category;
  document.getElementById('financeDescription').value = row.description;
  document.getElementById('financeAmount').value = row.amount;
  document.getElementById('financePaymentMethod').value = row.payment_method;
  document.getElementById('financeReference').value = row.reference || '';
  document.getElementById('financeReceiptPath').value = row.receipt_path || '';
  financeEditingReceiptPath = row.receipt_path || '';
  document.getElementById('financeReceiptHint').textContent = row.receipt_path
    ? 'Bukti tersimpan. Pilih file baru jika ingin menggantinya.'
    : 'Wajib untuk pemasukan/pengeluaran; saldo awal boleh tanpa foto.';
  document.getElementById('financeTransactionForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function approveFinanceTransaction(id) {
  if (!window.confirm('Setujui transaksi ini dan masukkan ke saldo berjalan?')) return;
  try {
    await supabaseRpc('spas1_approve_finance_transaction', { p_transaction_id: id });
    showToast('✅ Transaksi disetujui.');
    await loadFinanceTransactions();
  } catch (error) {
    showToast('❌ Gagal menyetujui transaksi: ' + error.message);
  }
}

async function rejectFinanceTransaction(id) {
  const reason = window.prompt('Alasan penolakan transaksi:');
  if (reason === null) return;
  try {
    await supabaseRpc('spas1_reject_finance_transaction', { p_transaction_id: id, p_reason: reason.trim() });
    showToast('✅ Transaksi ditolak dengan alasan tercatat.');
    await loadFinanceTransactions();
  } catch (error) {
    showToast('❌ Gagal menolak transaksi: ' + error.message);
  }
}

async function deleteFinanceTransaction(id) {
  if (!window.confirm('Hapus transaksi ini? Perubahan akan tercatat di audit keuangan.')) return;
  try {
    await supabaseRpc('spas1_delete_finance_transaction', { p_transaction_id: id });
    showToast('✅ Transaksi dihapus dan dicatat pada audit.');
    await loadFinanceTransactions();
  } catch (error) {
    showToast('❌ Gagal menghapus transaksi: ' + error.message);
  }
}

function exportFinanceExcel() {
  if (!window.XLSX || !window.XLSX.utils || typeof window.XLSX.writeFile !== 'function') {
    showToast('❌ Library Excel belum termuat. Muat ulang halaman lalu coba kembali.');
    return;
  }
  const rows = getFilteredFinanceTransactions();
  const data = [['Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Jumlah (Rp)', 'Metode / Sumber', 'Referensi', 'Status', 'Bukti']];
  rows.forEach(function(row) {
    data.push([row.transaction_date, financeTypeLabel(row.transaction_type), row.category, row.description, Number(row.amount), row.payment_method, row.reference || '', financeStatusLabel(row.status), row.receipt_path || '']);
  });
  const approved = financeTransactions.filter(function(row) { return row.status === 'approved'; });
  const openingBalance = approved.filter(function(row) { return row.transaction_type === 'saldo_awal'; }).reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
  const income = approved.filter(function(row) { return row.transaction_type === 'pemasukan'; }).reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
  const expense = approved.filter(function(row) { return row.transaction_type === 'pengeluaran'; }).reduce(function(total, row) { return total + Number(row.amount || 0); }, 0);
  data.push([]);
  data.push(['Saldo Awal Disetujui', '', '', '', openingBalance]);
  data.push(['Pemasukan Disetujui', '', '', '', income]);
  data.push(['Pengeluaran Disetujui', '', '', '', expense]);
  data.push(['Saldo Berjalan', '', '', '', openingBalance + income - expense]);
  const sheet = window.XLSX.utils.aoa_to_sheet(data);
  sheet['!cols'] = [{ wch: 14 }, { wch: 18 }, { wch: 24 }, { wch: 40 }, { wch: 18 }, { wch: 24 }, { wch: 22 }, { wch: 18 }, { wch: 44 }];
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, 'Transaksi_Keuangan');
  window.XLSX.writeFile(workbook, 'Transaksi_Keuangan_' + localDateInputValue() + '.xlsx');
}

function printFinanceReport() {
  preparePrint('printing-view-admin');
  document.body.classList.add('printing-admin-finance');
  window.setTimeout(function() {
    window.print();
    window.setTimeout(cleanupPrint, 500);
  }, 250);
}
