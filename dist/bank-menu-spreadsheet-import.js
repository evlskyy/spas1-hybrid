(function(root, factory) {
  const importer = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = importer;
  if (root) root.SPAS1MenuSpreadsheetImport = importer;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const sourceCategory = 'Menu SPPG Sungai Pasir1 Meral';
  const headers = [
    'No',
    'Kategori',
    'Karbohidrat',
    'Prohe / Protein Hewani',
    'Prona / Protein Nabati',
    'Sayuran / Serat',
    'Buah / Pelengkap'
  ];

  function normalizeOrganizationName(value) {
    return String(value || '')
      .trim()
      .replace(/^menu\s+/i, '')
      .replace(/^sppg\s+/i, '')
      .replace(/\s*,\s*karimun$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function matchesTenantOrganization(organizationName) {
    return normalizeOrganizationName(organizationName) === normalizeOrganizationName(sourceCategory);
  }

  function parseCsv(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('File CSV kosong.');
    const input = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (quoted) {
        if (character === '"' && input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"' && field.length === 0) {
        quoted = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n' || character === '\r') {
        row.push(field);
        if (row.some(function(value) { return value.trim() !== ''; })) rows.push(row);
        row = [];
        field = '';
        if (character === '\r' && input[index + 1] === '\n') index += 1;
      } else {
        field += character;
      }
    }

    if (quoted) throw new Error('Format CSV tidak valid: tanda kutip belum ditutup.');
    row.push(field);
    if (row.some(function(value) { return value.trim() !== ''; })) rows.push(row);
    if (!rows.length) throw new Error('File CSV tidak berisi baris data.');
    return rows;
  }

  function parseMenuSpreadsheetCsv(text) {
    const rows = parseCsv(text);
    const headerRow = rows[0].map(function(value) { return value.trim(); });
    const columnIndexes = headers.reduce(function(result, header) {
      const index = headerRow.indexOf(header);
      if (index === -1) throw new Error('Kolom wajib tidak ditemukan: ' + header + '.');
      result[header] = index;
      return result;
    }, {});
    const seenSourceNumbers = new Set();
    const records = [];

    rows.slice(1).forEach(function(row) {
      const category = String(row[columnIndexes.Kategori] || '').trim().replace(/\s+/g, ' ');
      if (category !== sourceCategory) return;

      const sourceNo = Number(String(row[columnIndexes.No] || '').trim());
      if (!Number.isSafeInteger(sourceNo) || sourceNo < 1 || sourceNo > 500) {
        throw new Error('Nomor baris menu SPPG tidak valid: ' + String(row[columnIndexes.No] || '') + '.');
      }
      if (seenSourceNumbers.has(sourceNo)) throw new Error('Nomor menu spreadsheet berulang: ' + sourceNo + '.');
      seenSourceNumbers.add(sourceNo);

      const record = {
        sourceNo: sourceNo,
        sourceCategory: category,
        karbohidrat: String(row[columnIndexes.Karbohidrat] || '').trim(),
        proteinHewani: String(row[columnIndexes['Prohe / Protein Hewani']] || '').trim(),
        proteinNabati: String(row[columnIndexes['Prona / Protein Nabati']] || '').trim(),
        sayuran: String(row[columnIndexes['Sayuran / Serat']] || '').trim(),
        buah: String(row[columnIndexes['Buah / Pelengkap']] || '').trim()
      };
      if (!Object.keys(record).some(function(key) {
        return ['karbohidrat', 'proteinHewani', 'proteinNabati', 'sayuran', 'buah'].includes(key) && record[key];
      })) {
        throw new Error('Menu spreadsheet nomor ' + sourceNo + ' tidak memiliki komponen.');
      }
      records.push(record);
    });

    if (!records.length) throw new Error('Tidak ditemukan baris dengan kategori "' + sourceCategory + '".');
    return records;
  }

  return {
    sourceCategory: sourceCategory,
    spreadsheetId: '1uybUy_wgbrDn5FeOqiheT1ntCT4TW8AM0mCKYi7ud-s',
    matchesTenantOrganization: matchesTenantOrganization,
    parseMenuSpreadsheetCsv: parseMenuSpreadsheetCsv
  };
});
