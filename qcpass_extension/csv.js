// Pure CSV serialization for the captured QC records. Kept dependency-free and UMD-wrapped so it
// can load as a content script / popup script (attaches window.QCCsv) AND be required from a
// node:test unit test. No DOM, no chrome APIs — just data in, CSV string out.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof self !== 'undefined') self.QCCsv = mod;
  else if (typeof globalThis !== 'undefined') globalThis.QCCsv = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  function escapeCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // Union of keys across records, in first-seen order (stable, no keys dropped).
  function columnsOf(records) {
    const seen = new Set(), cols = [];
    for (const r of (records || [])) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) { if (!seen.has(k)) { seen.add(k); cols.push(k); } }
    }
    return cols;
  }
  function toCsv(records, columns) {
    records = Array.isArray(records) ? records : [];
    const cols = (columns && columns.length) ? columns : columnsOf(records);
    const lines = [cols.map(escapeCell).join(',')];
    for (const r of records) lines.push(cols.map((c) => escapeCell(r ? r[c] : '')).join(','));
    return lines.join('\r\n');
  }
  return { toCsv, columnsOf, escapeCell };
});
