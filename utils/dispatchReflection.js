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

  // Not fully reflected — estimate the arrived fraction from the last snapshot.
  const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
  if (lastSnap) {
    const arrived = (Number(lastSnap.qty) || 0) - (sohBefore - cumThrough(sales, lastSnap.date));
    const f = Math.max(0, Math.min(1, totalDispatched ? arrived / totalDispatched : 0));
    out.reflected_qty = Math.round(f * totalDispatched);
    out.gap_qty = totalDispatched - out.reflected_qty;
  }

  const deadline = addDays(lastDispatchDate, Number(input.deadlineDays) || 0);
  const f = totalDispatched ? out.reflected_qty / totalDispatched : 1;
  if (input.today < deadline) { out.status = 'pending'; return out; }
  if (f <= tolPct / 100) out.status = 'not_reflected';
  else if (f >= 1 - tolPct / 100) {
    out.status = 'reflected';
    out.reflected_qty = totalDispatched; out.gap_qty = 0;
    if (lastSnap) { out.reflected_date = lastSnap.date; out.lag_days = daysBetween(lastDispatchDate, lastSnap.date); }
  } else out.status = 'partial';
  return out;
}

module.exports = { assessReflection, addDays, daysBetween };
