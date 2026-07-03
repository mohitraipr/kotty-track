// utils/qcDashboard.js
//
// Pure (DB-free) logic for the QC dashboard API, extracted so it can be
// unit-tested without a live database:
//   - buildPassesQuery(filters)  -> { sql, params }  (parameterized SELECT)
//   - rowsToCsv(rows)            -> CSV string (RFC-4180-ish escaping)
//   - summarizeByUser(rows)      -> [{ user, passes }]  (grouped count)
//   - istToday()                 -> 'YYYY-MM-DD' in IST (default date range)
//
// CAPTURES-BASED: one row per return item SCANNED by a user (qc_return_captures),
// which is where the full product detail lives (sku_code, style_id, size,
// product_name, tracking_number). Whether that item was later QC-passed is
// LEFT-joined from qc_return_passes ON item_barcode (the physical item key) —
// NOT on capture_uid, which is derived from different inputs in each table and
// therefore never matches. `pass_success`/`passed_at` are NULL when a scanned
// item was never passed.

// Ordered column set the API returns for each detail row. Also the CSV header order.
// The FULL captured record (everything shown in the extension panel), plus the joined
// pass outcome (pass_success/passed_at).
const ROW_COLUMNS = [
  'captured_at',
  'username',
  'tracking_number',
  'item_barcode',
  'product_name',
  'article_no',
  'style_id',
  'size',
  'price',
  'return_type',
  'return_mode',
  'return_status',
  'rms_status',
  'qc_action',
  'quality',
  'created_date',
  'refund_date',
  'return_received_on',
  'return_restocked_on',
  'logistics_status',
  'courier_code',
  'return_hub',
  'dispatch_wh',
  'return_destination_wh',
  'delivery_center',
  'ship_city',
  'return_id',
  'oms_release_id',
  'sku_id',
  'sku_code',
  'pass_success',
  'passed_at',
];

// SELECT clause that produces exactly ROW_COLUMNS (in order). DATE columns are
// formatted to YYYY-MM-DD so they render clean (no timezone-shifted timestamps).
// The passes side is pre-aggregated to ONE row per item_barcode (MAX passed_at /
// MAX pass_success) so a rare double-pass can't fan a capture into duplicate rows.
const SELECT_SQL = `
  SELECT
    DATE_FORMAT(COALESCE(c.captured_at, c.ingested_at), '%Y-%m-%d %H:%i:%s') AS captured_at,
    u.username             AS username,
    c.tracking_number      AS tracking_number,
    c.item_barcode         AS item_barcode,
    c.product_name         AS product_name,
    c.article_no           AS article_no,
    c.style_id             AS style_id,
    c.size                 AS size,
    c.price                AS price,
    c.return_type          AS return_type,
    c.return_mode          AS return_mode,
    c.return_status        AS return_status,
    c.rms_status           AS rms_status,
    c.qc_action            AS qc_action,
    c.quality              AS quality,
    DATE_FORMAT(c.created_date, '%Y-%m-%d')          AS created_date,
    DATE_FORMAT(c.refund_date, '%Y-%m-%d')           AS refund_date,
    DATE_FORMAT(c.return_received_on, '%Y-%m-%d')    AS return_received_on,
    DATE_FORMAT(c.return_restocked_on, '%Y-%m-%d')   AS return_restocked_on,
    c.logistics_status     AS logistics_status,
    c.courier_code         AS courier_code,
    c.return_hub           AS return_hub,
    c.dispatch_wh          AS dispatch_wh,
    c.return_destination_wh AS return_destination_wh,
    c.delivery_center      AS delivery_center,
    c.ship_city            AS ship_city,
    c.return_id            AS return_id,
    c.oms_release_id       AS oms_release_id,
    c.sku_id               AS sku_id,
    c.sku_code             AS sku_code,
    p.pass_success         AS pass_success,
    DATE_FORMAT(p.passed_at, '%Y-%m-%d %H:%i:%s') AS passed_at
  FROM qc_return_captures c
  LEFT JOIN users u ON u.id = c.captured_by
  LEFT JOIN (
    SELECT item_barcode, MAX(pass_success) AS pass_success, MAX(passed_at) AS passed_at
    FROM qc_return_passes
    GROUP BY item_barcode
  ) p ON p.item_barcode = c.item_barcode`.trim();

// The captured-day / captured-timestamp expressions, reused by WHERE + ORDER BY.
const CAPTURED_DAY = 'DATE(COALESCE(c.captured_at, c.ingested_at))';
const CAPTURED_TS = 'COALESCE(c.captured_at, c.ingested_at)';

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
 * Build the parameterized captures query from user filters. NEVER string-
 * concatenates user input — every dynamic value goes in `params`.
 *
 * filters: { from, to, user, quality, qc_action, warehouse, q }
 *   from/to  inclusive on DATE(captured_at); default to today (IST) when absent.
 *   user     matches users.username (the operator who scanned).
 *   quality / qc_action  exact matches on the captured return.
 *   warehouse            exact match on the return destination warehouse.
 *   q        free-text, grouped OR LIKE across
 *            sku_code / style_id / item_barcode / tracking_number / product_name.
 *
 * Returns { sql, params, from, to }.
 */
function buildPassesQuery(filters = {}) {
  const today = istToday();
  const from = sanitizeDate(filters.from, today);
  const to = sanitizeDate(filters.to, today);

  const where = [`${CAPTURED_DAY} BETWEEN ? AND ?`];
  const params = [from, to];

  if (nonEmpty(filters.user)) {
    where.push('u.username = ?');
    params.push(String(filters.user).trim());
  }
  if (nonEmpty(filters.quality)) {
    where.push('c.quality = ?');
    params.push(String(filters.quality).trim());
  }
  if (nonEmpty(filters.qc_action)) {
    where.push('c.qc_action = ?');
    params.push(String(filters.qc_action).trim());
  }
  if (nonEmpty(filters.warehouse)) {
    where.push('c.return_destination_wh = ?');
    params.push(String(filters.warehouse).trim());
  }
  if (nonEmpty(filters.q)) {
    const like = `%${String(filters.q).trim()}%`;
    where.push(
      '(c.sku_code LIKE ? OR c.style_id LIKE ? OR c.item_barcode LIKE ? OR c.tracking_number LIKE ? OR c.product_name LIKE ?)'
    );
    params.push(like, like, like, like, like);
  }

  const sql = `${SELECT_SQL}\n  WHERE ${where.join('\n    AND ')}\n  ORDER BY ${CAPTURED_TS} DESC`;
  return { sql, params, from, to };
}

/** Group rows into a per-user scan count: [{ user, passes }], busiest first.
 *  (`passes` = number of returns that user scanned in range.) */
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
