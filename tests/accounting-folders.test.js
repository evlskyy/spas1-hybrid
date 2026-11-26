const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lpj = fs.readFileSync(path.join(root, 'lpj.js'), 'utf8');
const groupStart = html.indexOf('function groupAccountingReportDates(');
const groupEnd = html.indexOf('\nfunction renderAccountingReportFolders', groupStart);
const groupSource = html.slice(groupStart, groupEnd);
const renderStart = html.indexOf('function renderAccountingReportFolders(');
const renderEnd = html.indexOf('\nasync function loadAccountingReportFolders', renderStart);
const renderSource = html.slice(renderStart, renderEnd);
const navigationStart = html.indexOf('function openAccountingReportFolder(');
const navigationEnd = html.indexOf('\nfunction switchAdminTab', navigationStart);
const navigationSource = html.slice(navigationStart, navigationEnd);

test('LPDH and LPJ reports are combined into date folders', function() {
  const context = {};
  vm.runInNewContext(groupSource, context);

  const folders = context.groupAccountingReportDates(
    ['2026-11-14', '2026-11-12'],
    ['2026-11-14', '2026-11-13']
  );

  assert.deepEqual(Array.from(folders, function(folder) {
    return [folder.date, folder.lpdh, folder.lpj];
  }), [
    ['2026-11-14', true, true],
    ['2026-11-13', false, true],
    ['2026-11-12', true, false]
  ]);
});

test('invalid saved report dates are rejected before creating folders', function() {
  const context = {};
  vm.runInNewContext(groupSource, context);

  assert.throws(function() {
    context.groupAccountingReportDates(['2026-02-30'], []);
  }, /tanggal laporan yang tidak valid/);
});

test('date folder opens a detail page with its available reports', function() {
  const list = { innerHTML: '', hidden: false };
  const detail = { innerHTML: '', hidden: true };
  const folders = [{ date: '2026-11-14', lpdh: true, lpj: false }];
  const context = {
    document: {
      getElementById: function(id) {
        return id === 'accountingReportFolderList' ? list :
          id === 'accountingReportFolderDetail' ? detail : null;
      }
    },
    accountingReportFolders: folders,
    accountingReportFoldersLoaded: true,
    currentAccountingReportFolder: '',
    escapeHtml: function(value) { return String(value); }
  };
  vm.runInNewContext(renderSource, context);
  vm.runInNewContext(navigationSource, context);
  context.renderAccountingReportFolders();

  assert.match(list.innerHTML, /class="accounting-folder-card"/);
  assert.match(list.innerHTML, /14\/11\/2026/);
  context.openAccountingReportFolder('2026-11-14');

  assert.equal(list.hidden, true);
  assert.equal(detail.hidden, false);
  assert.match(detail.innerHTML, /Folder Laporan 14\/11\/2026/);
  assert.match(detail.innerHTML, /Buka LPDH/);
  assert.match(detail.innerHTML, /Belum ada LPJ/);
  assert.match(detail.innerHTML, /showAccountingReportFolderList/);
});

test('opening a saved report folder sets its date and selects the report tab', function() {
  const dateInput = { value: '' };
  const navButton = { id: 'nav-tab-lpdh' };
  const switched = [];
  const context = {
    accountingReportFolders: [{ date: '2026-11-14', lpdh: true, lpj: false }],
    document: {
      getElementById: function(id) {
        return id === 'lpdhReportDate' ? dateInput :
          id === 'nav-tab-lpdh' ? navButton : null;
      }
    },
    switchAdminTab: function(tabId, button) { switched.push([tabId, button]); },
    showToast: function() {}
  };
  vm.runInNewContext(navigationSource, context);

  context.openAccountingReportFromFolder('lpdh', '2026-11-14');

  assert.equal(dateInput.value, '2026-11-14');
  assert.equal(switched[0][0], 'tab-lpdh');
  assert.equal(switched[0][1], navButton);
});

test('accounting archive reads existing Supabase reports and refreshes after saves', function() {
  assert.match(html, /case 'listLpdhReportDates'/);
  assert.match(html, /case 'listLpjReportDates'/);
  assert.match(html, /supabaseRequest\('spas1_lpdh_reports'/);
  assert.match(html, /supabaseRequest\('spas1_lpj_reports'/);
  assert.match(html, /tab-accounting-folders/);
  assert.match(html, /src="assets\/spas1-folder\.svg"/);
  assert.match(html, /loadAccountingReportFolders\(\);/);
  assert.match(lpj, /window\.loadAccountingReportFolders\(\)/);
  assert.match(html, /function openAccountingReportFromFolder\(reportType, date\)/);
});

test('accounting archive visibly explains the right-click new folder action', function() {
  assert.match(html, /accounting-folder-context-hint/);
  assert.match(html, /klik kanan pada area arsip ini lalu pilih <strong>New folder<\/strong>/);
  assert.match(html, /id="accountingFolderContextMenu"[\s\S]*createAccountingReportFolderPrompt\(\)/);
});

test('new accounting folders are saved by tenant and merged after tab reload', function() {
  assert.match(html, /spas1-accounting-report-folders:/);
  assert.match(html, /function saveAccountingReportFolders\(\)/);
  assert.match(html, /function loadSavedAccountingReportFolders\(\)/);
  assert.match(html, /mergeAccountingReportFolders\(/);
  assert.match(html, /saveAccountingReportFolders\(\);/);
});

test('stock tab includes a right-click new folder flow for daily stock archive', function() {
  assert.doesNotMatch(html, /Folder Hari Ini/);
  assert.match(html, /New folder/);
  assert.match(html, /createStockFolderPrompt\(\)/);
});

test('purchase transaction archive opens by date folder and is mobile responsive', function() {
  assert.match(html, /function renderPurchaseTransactionFolders\(\)/);
  assert.match(html, /function openPurchaseTransactionFolder\(date\)/);
  assert.match(html, /Kembali ke semua folder/);
  assert.match(html, /Pilih PO dalam folder untuk melihat rincian/);
  assert.match(html, /@media \(max-width: 768px\)[\s\S]*\.sl-purchase-archive-body \{ grid-template-columns:1fr;/);
  assert.doesNotMatch(html, /\/\*\s*const grouped = new Map\(\)/);
});

test('purchase order detail expands to a full-page view with a back control', function() {
  assert.match(html, /\.sl-purchase-archive-overlay\.has-purchase-detail \.sl-purchase-archive-list \{ display:none; \}/);
  assert.match(html, /\.sl-purchase-archive-overlay\.has-purchase-detail \.sl-purchase-archive-detail \{ width:100%;/);
  assert.match(html, /\.sl-purchase-archive-overlay\.has-purchase-detail \{ padding:16px;align-items:center; \}/);
  assert.match(html, /\.sl-purchase-archive-overlay\.has-purchase-detail \.sl-purchase-archive-card \{ width:min\(1100px,100%\);height:auto;/);
  assert.match(html, /classList\.add\('has-purchase-detail'\)/);
  assert.match(html, /function backToPurchaseTransactionList\(\)/);
  assert.match(html, /class="sl-purchase-detail-back btn-kembali-animated" onclick="backToPurchaseTransactionList\(\)"/);
  assert.match(html, /\.sl-purchase-detail-back \{[^}]*rgba\(2,44,34,\.8\)[^}]*#6EE7B7/);
  assert.match(html, /body\.app-light-mode \.sl-purchase-detail-back \{[^}]*#047857/);
});

test('purchase archive folder cards use high-contrast colors in the default light theme', function() {
  assert.match(html, /body\.app-light-mode \.sl-purchase-archive-folder \{ border-color:#94A3B8;background:#F1F5F9;color:#0F172A; \}/);
  assert.match(html, /body\.app-light-mode \.sl-purchase-archive-folder\[aria-current="true"\] \{ border-color:#047857;background:#D1FAE5;color:#064E3B; \}/);
  assert.match(html, /body\.app-light-mode \.sl-purchase-archive-folder small \{ color:#166534; \}/);
  assert.match(html, /body\.app-light-mode \.sl-purchase-archive-folder-count \{ background:#166534;color:#FFFFFF; \}/);
});

test('audit stock page does not expose the folder shortcut or print action', function() {
  assert.doesNotMatch(html, /openStockAuditFolderPicker\(\)/);
  assert.doesNotMatch(html, /id="stockFolderList"/);
  assert.doesNotMatch(html, /Cetak Audit/);
});
