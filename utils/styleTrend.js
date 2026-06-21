'use strict';

// Bucket label for a 'YYYY-MM-DD' date. weekly → the Monday (YYYY-MM-DD) of that
// week; monthly → 'YYYY-MM'; daily → the date itself. (Monday-keyed weeks avoid
// ISO week-number edge cases and sort lexically = chronologically.)
function trendBucketKey(ymd, granularity) {
  if (granularity === 'monthly') return String(ymd).slice(0, 7);
  if (granularity === 'weekly') {
    const d = new Date(ymd + 'T00:00:00Z');
    const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }
  return String(ymd);
}

// salesDaily/invDaily: [{date:'YYYY-MM-DD', qty}], chronological. Sales summed per
// bucket; inventory = last (latest-date) value per bucket. Both returned sorted by
// bucket label (lexical == chronological for these key formats).
function buildTrendBuckets({ salesDaily, invDaily, granularity }) {
  const gran = ['daily', 'weekly', 'monthly'].includes(granularity) ? granularity : 'daily';
  const salesMap = new Map();
  for (const r of (salesDaily || [])) {
    const k = trendBucketKey(r.date, gran);
    salesMap.set(k, (salesMap.get(k) || 0) + (Number(r.qty) || 0));
  }
  const invMap = new Map();
  for (const r of (invDaily || [])) {
    // input is chronological → later dates overwrite, so the latest value per bucket wins
    invMap.set(trendBucketKey(r.date, gran), Number(r.qty) || 0);
  }
  const toSorted = (m) => [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, qty]) => ({ bucket, qty }));
  return { sales: toSorted(salesMap), inventory: toSorted(invMap) };
}

const { deriveStyle } = require('./easyecomAnalytics');

const toYmd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function computeStyleTrend(pool, { style, days, granularity } = {}) {
  const st = String(style || '').trim().toUpperCase();
  if (!st) return { sales: [], inventory: [] };
  const n = Math.min(90, Math.max(1, Number(days) || 30));
  const gran = ['daily', 'weekly', 'monthly'].includes(granularity) ? granularity : 'daily';
  try {
    const [skuRows] = await pool.query(
      `SELECT DISTINCT sku FROM (
         SELECT sku FROM ee_sales_daily
           WHERE sku LIKE CONCAT(?, '%') AND sale_date >= CURDATE() - INTERVAL ? DAY
         UNION
         SELECT sku FROM ee_inventory_daily_snapshot
           WHERE sku LIKE CONCAT(?, '%') AND snapshot_date >= CURDATE() - INTERVAL ? DAY
       ) u`,
      [st, n, st, n]
    );
    const skus = skuRows.map((r) => r.sku).filter((s) => deriveStyle(s) === st);
    if (!skus.length) return { sales: [], inventory: [] };

    const [salesRows] = await pool.query(
      `SELECT sale_date AS date, SUM(qty) AS qty FROM ee_sales_daily
        WHERE sku IN (?) AND source = 'mini_sales_report' AND sale_date >= CURDATE() - INTERVAL ? DAY
        GROUP BY sale_date ORDER BY sale_date`,
      [skus, n]
    );
    const [invRows] = await pool.query(
      `SELECT snapshot_date AS date, SUM(qty) AS qty FROM ee_inventory_daily_snapshot
        WHERE sku IN (?) AND snapshot_date >= CURDATE() - INTERVAL ? DAY
        GROUP BY snapshot_date ORDER BY snapshot_date`,
      [skus, n]
    );

    return buildTrendBuckets({
      salesDaily: salesRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
      invDaily: invRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
      granularity: gran,
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { sales: [], inventory: [] };
    throw err;
  }
}

module.exports = { trendBucketKey, buildTrendBuckets, computeStyleTrend };
