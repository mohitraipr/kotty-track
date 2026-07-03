// utils/qcDashboard.js
//
// Pure (DB-free) logic for the QC dashboard passes API, extracted so it can be
// unit-tested without a live database:
//   - buildPassesQuery(filters)  -> { sql, params }  (parameterized SELECT)
//   - rowsToCsv(rows)            -> CSV string (RFC-4180-ish escaping)
//   - summarizeByUser(rows)      -> [{ user, passes }]  (grouped count)
//   - istToday()                 -> 'YYYY-MM-DD' in IST (default date range)
//
// A row in qc_return_passes is one QC pass by user `passed_by`. Product detail
// (sku_code, style_id, size, product_name, tracking_number) lives in
// qc_return_captures, joined on capture_uid.

// Ordered column set the API returns for each detail row. Also the CSV header order.
const ROW_COLUMNS = [
  'passed_at',
  'username',
  'item_barcode',
  'tracking_number',
  'sku_code',
  'style_id',
  'size',
  'quality',
  'qc_action',
  'warehouse_id',
  'pass_success',
];

// SELECT clause that produces exactly ROW_COLUMNS (in order).
const SELECT_SQL = `
  SELECT
    DATE_FORMAT(p.passed_at, '%Y-%m-%d %H:%i:%s') AS passed_at,
    u.username        AS username,
    p.item_barcode    AS item_barcode,
    c.tracking_number AS tracking_number,
    c.sku_code        AS sku_code,
    c.style_id        AS style_id,
    c.size            AS size,
    p.quality         AS quality,
    p.qc_action       AS qc_action,
    p.warehouse_id    AS warehouse_id,
    p.pass_success    AS pass_success
  FROM qc_return_passes p
  LEFT JOIN users u ON u.id = p.passed_by
  LEFT JOIN qc_return_captures c ON c.capture_uid = p.capture_uid`.trim();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Current date in IST (Asia/Kolkata) as 'YYYY-MM-DD'. */
function istToday(now = new Date()) {
  // IST is a fixed +05:30 offset (no DST); shift the epoch and read UTC parts.
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Return `value` if it is a YYYY-MM-DD string, else `fallback`. */
function sanitizeDate(value, fallback) {
  return typeof value === 'string' && DATE_RE.test(value) ? value : fallback;
}

function nonEmpty(value) {
  return value != null && String(value).trim() !== '';
}

/**
 * Build the parameterized passes query from user filters. NEVER string-
 * concatenates user input — every dynamic value goes in `params`.
 *
 * filters: { from, to, user, quality, qc_action, warehouse, q }
 *   from/to  inclusive on DATE(passed_at); default to today (IST) when absent.
 *   user     matches users.username (the passer).
 *   quality / qc_action / warehouse  exact matches on the pass row.
 *   q        free-text, grouped OR LIKE across
 *            sku_code / style_id / item_barcode / tracking_number / product_name.
 *
 * Returns { sql, params, from, to }.
 */
function buildPassesQuery(filters = {}) {
  const today = istToday();
  const from = sanitizeDate(filters.from, today);
  const to = sanitizeDate(filters.to, today);

  const where = ['DATE(p.passed_at) BETWEEN ? AND ?'];
  const params = [from, to];

  if (nonEmpty(filters.user)) {
    where.push('u.username = ?');
    params.push(String(filters.user).trim());
  }
  if (nonEmpty(filters.quality)) {
    where.push('p.quality = ?');
    params.push(String(filters.quality).trim());
  }
  if (nonEmpty(filters.qc_action)) {
    where.push('p.qc_action = ?');
    params.push(String(filters.qc_action).trim());
  }
  if (nonEmpty(filters.warehouse)) {
    where.push('p.warehouse_id = ?');
    params.push(String(filters.warehouse).trim());
  }
  if (nonEmpty(filters.q)) {
    const like = `%${String(filters.q).trim()}%`;
    where.push(
      '(c.sku_code LIKE ? OR c.style_id LIKE ? OR p.item_barcode LIKE ? OR c.tracking_number LIKE ? OR c.product_name LIKE ?)'
    );
    params.push(like, like, like, like, like);
  }

  const sql = `${SELECT_SQL}\n  WHERE ${where.join('\n    AND ')}\n  ORDER BY p.passed_at DESC`;
  return { sql, params, from, to };
}

/** Group rows into a per-user pass count: [{ user, passes }], busiest first. */
function summarizeByUser(rows = []) {
  const counts = new Map();
  for (const r of rows) {
    const user = r.username || '(unknown)';
    counts.set(user, (counts.get(user) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([user, passes]) => ({ user, passes }))
    .sort((a, b) => b.passes - a.passes || a.user.localeCompare(b.user));
}

/** Escape one CSV field: quote when it contains comma, quote, CR or LF. */
function csvField(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize rows to CSV (header + one line per row, in ROW_COLUMNS order). */
function rowsToCsv(rows = []) {
  const lines = [ROW_COLUMNS.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(ROW_COLUMNS.map((col) => csvField(row[col])).join(','));
  }
  return lines.join('\r\n');
}

module.exports = {
  ROW_COLUMNS,
  buildPassesQuery,
  summarizeByUser,
  rowsToCsv,
  csvField,
  istToday,
  sanitizeDate,
};
