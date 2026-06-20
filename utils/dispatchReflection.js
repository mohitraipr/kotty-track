'use strict';

// UTC calendar-date helpers ('YYYY-MM-DD' in/out).
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const cumThrough = (rows, day) => rows.reduce((s, r) => (r.date <= day ? s + (Number(r.qty) || 0) : s), 0);

// Decide whether/when dispatched goods reflected in SOH, adjusting for concurrent
// sales: expected(day) = sohBefore + cumDispatched(<=day) - cumSales(<=day).
function assessReflection(input) {
  const dispatches = (input.dispatches || []).slice().sort(byDate);
  const sales = (input.sales || []).slice().sort(byDate);
  const snaps = (input.snapshots || []).slice().sort(byDate);
  const totalDispatched = dispatches.reduce((s, d) => s + (Number(d.qty) || 0), 0);
  const firstDispatchDate = dispatches.length ? dispatches[0].date : null;
  const lastDispatchDate = dispatches.length ? dispatches[dispatches.length - 1].date : null;
  const sohBefore = Number(input.sohBefore) || 0;
  const tolPct = Number(input.tolerancePct) || 0;
  const tol = Math.max(1, Math.round((tolPct / 100) * totalDispatched));

  const out = {
    status: 'pending', reflected_date: null, lag_days: null,
    reflected_qty: 0, gap_qty: totalDispatched,
    dispatched_qty: totalDispatched,
    first_dispatch_date: firstDispatchDate, last_dispatch_date: lastDispatchDate,
  };
  if (!totalDispatched || !firstDispatchDate) { out.status = 'reflected'; out.gap_qty = 0; return out; }

  // Full reflection: first day all batches are out AND actual >= expected - tol.
  for (const sn of snaps) {
    if (sn.date < firstDispatchDate) continue;
    const cumDisp = cumThrough(dispatches, sn.date);
    if (cumDisp < totalDispatched) continue;
    const expected = sohBefore + cumDisp - cumThrough(sales, sn.date);
    if ((Number(sn.qty) || 0) >= expected - tol) {
      out.status = 'reflected';
      out.reflected_date = sn.date;
      out.lag_days = daysBetween(lastDispatchDate, sn.date);
      out.reflected_qty = totalDispatched;
      out.gap_qty = 0;
      return out;
    }
  }

  // Not fully reflected in the loop. Estimate from the last snapshot, sales-adjusted,
  // and decide status with the SAME absolute-tolerance test the primary loop uses.
  const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
  let expectedLast = null;
  if (lastSnap) {
    const cumSalesLast = cumThrough(sales, lastSnap.date);
    expectedLast = sohBefore + cumThrough(dispatches, lastSnap.date) - cumSalesLast;
    const arrived = (Number(lastSnap.qty) || 0) - (sohBefore - cumSalesLast);
    out.reflected_qty = Math.max(0, Math.min(totalDispatched, Math.round(arrived)));
    out.gap_qty = totalDispatched - out.reflected_qty;
  }

  const deadline = addDays(lastDispatchDate, Number(input.deadlineDays) || 0);
  if (input.today < deadline) { out.status = 'pending'; return out; }
  if (lastSnap && (Number(lastSnap.qty) || 0) >= expectedLast - tol) {
    out.status = 'reflected';
    out.reflected_qty = totalDispatched; out.gap_qty = 0;
    out.reflected_date = lastSnap.date;
    out.lag_days = daysBetween(lastDispatchDate, lastSnap.date);
  } else if (out.reflected_qty <= tol) {
    out.status = 'not_reflected';
  } else {
    out.status = 'partial';
  }
  return out;
}

const { resolveSizeSku, loadResolutionMap, loadCanonSet } = require('./onOrder');

const toYmd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function reconcileDispatchReflection(pool, opts = {}) {
  const graceDays = Number(opts.graceDays ?? process.env.PM_REFLECT_GRACE_DAYS ?? 3);
  const deadlineDays = Number(opts.deadlineDays ?? process.env.PM_REFLECT_DEADLINE_DAYS ?? 7);
  const tolerancePct = Number(opts.tolerancePct ?? process.env.PM_REFLECT_TOLERANCE_PCT ?? 15);
  const windowDays = Number(opts.windowDays ?? deadlineDays + 14);
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const [groups] = await pool.query(
    `SELECT fd.lot_no, fd.size_label,
            COALESCE(SUM(fd.quantity),0) AS dispatched_qty,
            MIN(DATE(fd.sent_at)) AS first_dispatch_date,
            MAX(DATE(fd.sent_at)) AS last_dispatch_date,
            COUNT(*) AS batch_count,
            MAX(cl.sku) AS style
       FROM finishing_dispatches fd
       LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
      WHERE fd.sent_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY fd.lot_no, fd.size_label`,
    [windowDays]
  );

  const resolutionMap = await loadResolutionMap(pool);
  const canonSet = await loadCanonSet(pool);
  const summary = { processed: 0, reflected: 0, not_reflected: 0, partial: 0, pending: 0, unresolved: 0 };

  for (const g of groups) {
    summary.processed++;
    const firstDate = toYmd(g.first_dispatch_date);
    const lastDate = toYmd(g.last_dispatch_date);
    const sku = resolveSizeSku(g.style, g.size_label, resolutionMap, canonSet);

    let v, sohBeforeVal = null;
    if (!sku) {
      summary.unresolved++;
      v = { status: 'pending', reflected_date: null, lag_days: null, reflected_qty: 0,
            gap_qty: Number(g.dispatched_qty) || 0 };
    } else {
      const [[sb]] = await pool.query(
        `SELECT COALESCE(SUM(qty),0) AS qty FROM ee_inventory_daily_snapshot
          WHERE sku = ? AND snapshot_date = (
            SELECT MAX(snapshot_date) FROM ee_inventory_daily_snapshot
             WHERE sku = ? AND snapshot_date < ?)`,
        [sku, sku, firstDate]
      );
      sohBeforeVal = Number(sb && sb.qty) || 0;
      const [snapRows] = await pool.query(
        `SELECT snapshot_date AS date, SUM(qty) AS qty FROM ee_inventory_daily_snapshot
          WHERE sku = ? AND snapshot_date >= ? GROUP BY snapshot_date ORDER BY snapshot_date`,
        [sku, firstDate]
      );
      const [saleRows] = await pool.query(
        `SELECT sale_date AS date, SUM(qty) AS qty FROM ee_sales_daily
          WHERE sku = ? AND source = 'mini_sales_report' AND sale_date >= ?
          GROUP BY sale_date ORDER BY sale_date`,
        [sku, firstDate]
      );
      v = assessReflection({
        sohBefore: sohBeforeVal,
        dispatches: [{ date: lastDate, qty: Number(g.dispatched_qty) || 0 }],
        sales: saleRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
        snapshots: snapRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
        graceDays, deadlineDays, tolerancePct, today,
      });
    }

    summary[v.status] = (summary[v.status] || 0) + 1;

    await pool.query(
      `INSERT INTO pm_dispatch_reflection
         (lot_no,size_label,size_sku,style,dispatched_qty,first_dispatch_date,last_dispatch_date,
          batch_count,soh_before,reflected_qty,reflected_date,lag_days,gap_qty,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         size_sku=VALUES(size_sku), style=VALUES(style), dispatched_qty=VALUES(dispatched_qty),
         first_dispatch_date=VALUES(first_dispatch_date), last_dispatch_date=VALUES(last_dispatch_date),
         batch_count=VALUES(batch_count), soh_before=VALUES(soh_before),
         reflected_qty=VALUES(reflected_qty), reflected_date=VALUES(reflected_date),
         lag_days=VALUES(lag_days), gap_qty=VALUES(gap_qty), status=VALUES(status),
         reconciled_at=CURRENT_TIMESTAMP`,
      [g.lot_no, g.size_label, sku, g.style, Number(g.dispatched_qty) || 0, firstDate, lastDate,
       Number(g.batch_count) || 0, sohBeforeVal,
       v.reflected_qty, v.reflected_date, v.lag_days, v.gap_qty, v.status]
    );
  }
  return summary;
}

module.exports = { assessReflection, reconcileDispatchReflection, addDays, daysBetween };
