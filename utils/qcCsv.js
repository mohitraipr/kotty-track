// Pure CSV parsing/mapping for the QC-Capture recovery upload (routes/qcExtensionRoutes.js).
// No DB, no I/O — takes CSV text, returns the same record shape the /capture endpoint accepts
// (fed through normalizeCapture/normalizePass). Unit-tested in test/qcCsv.test.js.

// Field names normalizeCapture/normalizePass read. Always present on the output record (null when
// the column is absent) so downstream normalization is uniform and "missing column" is explicit.
const KNOWN_FIELDS = [
  // capture
  'return_id', 'item_barcode', 'tracking_number', 'oms_release_id', 'sku_id', 'sku_code',
  'style_id', 'article_no', 'product_name', 'size', 'price', 'return_type', 'return_mode',
  'return_status', 'rms_status', 'qc_action', 'quality', 'logistics_status', 'courier_code',
  'return_hub', 'dispatch_wh', 'return_destination_wh', 'delivery_center', 'ship_city',
  'created_date', 'refund_date', 'return_received_on', 'return_restocked_on', 'captured_at',
  // pass-only
  'desk_code', 'warehouse_id', 'pass_success', 'new_status', 'pass_error', 'passed_at',
];

// Robust RFC-4180-ish parser: quoted fields (with commas, newlines and "" escapes), CRLF or LF
// line endings, and a leading UTF-8 BOM. Returns a rectangular-ish string[][] (rows of cells).
function parseCsv(text) {
  let s = text == null ? '' : String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (s[i + 1] === '\n') i++; // CRLF
      continue;
    }
    if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      continue;
    }
    field += c;
  }
  // Flush the final field/row unless the input ended exactly on a line break (no trailing content).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function isEmptyRow(row) {
  return !Array.isArray(row) || row.every((c) => c == null || String(c).trim() === '');
}

// Header-driven mapping: first non-empty row is the header (case-insensitive, trimmed). Each
// subsequent non-empty row becomes a record keyed by header. Empty cells -> null. `_type` defaults
// to 'capture' (only an explicit 'pass' selects the pass path). Tolerant of missing columns.
function rowsToRecords(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  let h = 0;
  while (h < rows.length && isEmptyRow(rows[h])) h++;
  if (h >= rows.length) return [];
  const header = rows[h].map((x) => String(x == null ? '' : x).trim().toLowerCase());

  const records = [];
  for (let i = h + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isEmptyRow(row)) continue;
    const rec = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      const raw = row[c] == null ? '' : String(row[c]).trim();
      rec[key] = raw === '' ? null : raw;
    }
    rec._type = String(rec._type || '').toLowerCase() === 'pass' ? 'pass' : 'capture';
    for (const f of KNOWN_FIELDS) if (!(f in rec)) rec[f] = null;
    records.push(rec);
  }
  return records;
}

module.exports = { parseCsv, rowsToRecords, KNOWN_FIELDS };
