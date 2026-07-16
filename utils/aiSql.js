// SQL guard for the AI analyst — pure functions (no DB), unit-tested.
// Defense in depth: this app-level allowlist sits ON TOP of the session-level
// `SET SESSION transaction_read_only = 1` the analyst pool applies, and mysql2's
// single-statement default. Nothing here ever mutates data.

const ROW_CAP = 200;
const MAX_LIMIT = 500;

// Statements the analyst may run. Everything else is rejected.
const ALLOWED_START = /^\s*(select|show|describe|desc|explain)\b/i;

// Dangerous constructs that are technically readable-statement-compatible.
const FORBIDDEN = [
  /\binto\s+(outfile|dumpfile)\b/i,
  /\bload_file\s*\(/i,
  /\bfor\s+update\b/i,
  /\block\s+in\s+share\s+mode\b/i,
  /\bsleep\s*\(/i,
  /\bbenchmark\s*\(/i,
  /\bget_lock\s*\(/i,
];

// Validate + normalize one statement. Returns { sql } ready to run, or { error }.
function guardSql(raw) {
  let sql = String(raw || '').trim();
  if (!sql) return { error: 'Empty query' };

  // Single statement only: strip ONE trailing semicolon, reject any other.
  sql = sql.replace(/;\s*$/, '').trim();
  if (sql.includes(';')) return { error: 'Only a single statement is allowed' };

  if (!ALLOWED_START.test(sql)) {
    return { error: 'Only SELECT / SHOW / DESCRIBE / EXPLAIN queries are allowed' };
  }
  for (const re of FORBIDDEN) {
    if (re.test(sql)) return { error: 'Query uses a forbidden construct' };
  }

  // Row cap: SELECTs must carry a sane LIMIT; add one if missing.
  if (/^\s*select\b/i.test(sql)) {
    const m = sql.match(/\blimit\s+(\d+)(?:\s*,\s*(\d+))?\s*$/i);
    if (!m) {
      sql = `${sql} LIMIT ${ROW_CAP}`;
    } else {
      const n = m[2] != null ? Number(m[2]) : Number(m[1]);
      if (n > MAX_LIMIT) return { error: `LIMIT too large (max ${MAX_LIMIT} rows)` };
    }
  }
  return { sql };
}

// Shrink a result set for the model + UI: cap rows and cell length.
function capRows(rows, maxRows = ROW_CAP, maxCell = 300) {
  const out = [];
  for (const r of (rows || []).slice(0, maxRows)) {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      let val = v;
      if (val instanceof Date) val = val.toISOString();
      else if (Buffer.isBuffer(val)) val = '<binary>';
      else if (val !== null && typeof val === 'object') val = JSON.stringify(val);
      if (typeof val === 'string' && val.length > maxCell) val = val.slice(0, maxCell) + '…';
      o[k] = val;
    }
    out.push(o);
  }
  return out;
}

module.exports = { guardSql, capRows, ROW_CAP, MAX_LIMIT };
