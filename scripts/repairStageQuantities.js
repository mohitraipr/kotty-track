#!/usr/bin/env node
/**
 * repairStageQuantities.js — one-off, idempotent repair for the
 * "cutting = 10 but stitching = 20" class of data corruption.
 *
 * Confirmed mechanisms (see sql/diagnostics/stage_qty_reconciliation.sql):
 *   A) uniform inflation — every size row is a constant multiple (x2/x4/x10)
 *      of the cutting breakdown, in BOTH the legacy *_data rows and the
 *      *_events ledger (carried in by the stage-events backfill, which did
 *      not re-validate against cutting).
 *   B) exact-duplicate rows — a double/triple submit wrote byte-identical
 *      *_data rows AND identical events.
 *   C) malformed "extra batch" rows — e.g. a washing_in row whose size
 *      labels are 0,1,2,3,4 (cutting labels are 26,28,30,...). Junk.
 *
 * Unified, deterministic repair, per affected lot:
 *   1. drop JUNK rows/events  (size labels entirely disjoint from cutting)
 *   2. dedupe EXACT-duplicate *_data rows, and exact-duplicate events of the
 *      same type (keep the lowest id)
 *   3. for the legacy *_data breakdown and for each event_type in
 *      {approve, complete}: if it still sums to MORE than the cutting
 *      ceiling, proportionally scale its size rows down to the ceiling
 *      (largest-remainder rounding so the integer total is exact) and keep
 *      each row's total_pieces / event.pieces in sync
 *   4. clamp any stage_payments.qty for the lot that exceeds the ceiling and
 *      recompute total_amount from the configured rate
 *
 * Reject events are never scaled (rejected pieces are a separate ledger).
 * Re-running after a successful repair finds zero offenders and is a no-op.
 *
 * Usage:
 *   DB_PASSWORD=... node scripts/repairStageQuantities.js            # DRY RUN
 *   DB_PASSWORD=... node scripts/repairStageQuantities.js --apply    # WRITE
 *   ... --lot=ak3159            # restrict to one lot
 * Connection defaults target a cloud-sql-proxy on 127.0.0.1:3307; override
 * with DB_HOST / DB_PORT / DB_USER / DB_NAME.
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const LOT_FILTER = (process.argv.find(a => a.startsWith('--lot=')) || '').split('=')[1] || null;

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

// production stage -> table names
const STAGES = [
  { key: 'stitching',  data: 'stitching_data',       dsz: 'stitching_data_sizes',       fk: 'stitching_data_id',       ev: 'stitching_events',       evsz: 'stitching_event_sizes' },
  { key: 'assembly',   data: 'jeans_assembly_data',  dsz: 'jeans_assembly_data_sizes',  fk: 'jeans_assembly_data_id',  ev: 'jeans_assembly_events',  evsz: 'jeans_assembly_event_sizes' },
  { key: 'washing',    data: 'washing_data',         dsz: 'washing_data_sizes',         fk: 'washing_data_id',         ev: 'washing_events',         evsz: 'washing_event_sizes' },
  { key: 'washing_in', data: 'washing_in_data',      dsz: 'washing_in_data_sizes',      fk: 'washing_in_data_id',      ev: 'washing_in_events',      evsz: 'washing_in_event_sizes' },
  { key: 'finishing',  data: 'finishing_data',       dsz: 'finishing_data_sizes',       fk: 'finishing_data_id',       ev: 'finishing_events',       evsz: 'finishing_event_sizes' },
];

/**
 * Largest-remainder scale of a list of {key, pieces} down to `target`.
 * Returns a map key->newPieces with an exact integer sum === target.
 * Only call when current sum > target.
 */
function scaleToTarget(items, target) {
  const S = items.reduce((a, r) => a + r.pieces, 0);
  if (S <= target) return null;
  const raw = items.map(r => (r.pieces * target) / S);
  const out = raw.map(Math.floor);
  let rem = target - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem && k < order.length; k++) out[order[k].i]++;
  const m = new Map();
  items.forEach((r, i) => m.set(r.key, out[i]));
  return m;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'kotty_user',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'kotty_db',
    multipleStatements: false,
  });

  const backup = { startedAt: new Date().toISOString(), apply: APPLY, lots: [] };
  const log = [];

  // ── Identify affected lots via the diagnostic reconciliation (one query),
  //    then process ONLY those lots (keeps the run fast + connection alive). ──
  const offenderLotNos = await offenderLots(conn);
  const lotList = LOT_FILTER ? offenderLotNos.filter(l => l === LOT_FILTER) : offenderLotNos;
  const [cutLots] = lotList.length
    ? await conn.query(
        `SELECT cl.id, cl.lot_no,
                COALESCE((SELECT SUM(total_pieces) FROM cutting_lot_sizes WHERE cutting_lot_id=cl.id),0) AS cut
         FROM cutting_lots cl WHERE cl.lot_no IN (?)`, [lotList])
    : [[]];
  console.log(`Offender lots from diagnostic: ${offenderLotNos.length}${LOT_FILTER ? ` (filtered to ${lotList.length})` : ''}`);

  let affected = 0;
  for (const lot of cutLots) {
    const cut = Math.round(Number(lot.cut));
    if (cut <= 0) continue;
    const cutLabels = new Set();
    const [cs] = await conn.query(`SELECT size_label FROM cutting_lot_sizes WHERE cutting_lot_id=?`, [lot.id]);
    cs.forEach(r => cutLabels.add(norm(r.size_label)));

    const lotBackup = { lot_no: lot.lot_no, cutting_lot_id: lot.id, cut, ops: [] };
    let lotTouched = false;

    for (const st of STAGES) {
      // legacy rows + sizes
      const [drows] = await conn.query(
        `SELECT d.id, d.total_pieces FROM ${st.data} d WHERE d.lot_no=? ORDER BY d.id`, [lot.lot_no]
      );
      if (!drows.length) continue;
      const dIds = drows.map(r => r.id);
      const [dsizes] = await conn.query(
        `SELECT id, ${st.fk} AS pid, size_label, pieces FROM ${st.dsz} WHERE ${st.fk} IN (?)`, [dIds]
      );
      // events + sizes
      const [erows] = await conn.query(
        `SELECT id, event_type, pieces FROM ${st.ev} WHERE cutting_lot_id=? ORDER BY id`, [lot.id]
      );
      const eIds = erows.map(r => r.id);
      const [esizes] = eIds.length
        ? await conn.query(`SELECT event_id, size_label, pieces FROM ${st.evsz} WHERE event_id IN (?)`, [eIds])
        : [[]];

      const ops = await repairStage(conn, st, lot, cut, cutLabels, drows, dsizes, erows, esizes);
      if (ops.length) {
        lotTouched = true;
        lotBackup.ops.push({ stage: st.key, ops });
        for (const op of ops) log.push(`${lot.lot_no} [${st.key}] ${op.summary}`);
      }
    }

    // payments: clamp qty>cut once per lot
    const payOps = await repairPayments(conn, lot, cut);
    if (payOps.length) {
      lotTouched = true;
      lotBackup.ops.push({ stage: 'payments', ops: payOps });
      for (const op of payOps) log.push(`${lot.lot_no} [payment] ${op.summary}`);
    }

    if (lotTouched) { affected++; backup.lots.push(lotBackup); }
  }

  // ── write backup + apply ──
  if (backup.lots.length) {
    const dir = path.join(__dirname, 'repair-backups');
    fs.mkdirSync(dir, { recursive: true });
    const fname = path.join(dir, `repair-backup-${backup.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(fname, JSON.stringify(backup, null, 2));
    console.log(`\nBackup (pre-images + planned ops) written to: ${fname}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — ${affected} lot(s) affected, ${log.length} operation(s).`);
  console.log('='.repeat(70));
  log.forEach(l => console.log('  ' + l));

  if (APPLY && backup.lots.length) {
    console.log('\nExecuting writes (one transaction per lot)…');
    for (const lb of backup.lots) {
      await conn.beginTransaction();
      try {
        for (const stageOps of lb.ops) for (const op of stageOps.ops) {
          for (const sql of op.sql) await conn.query(sql.q, sql.p);
        }
        await conn.commit();
        console.log(`  committed ${lb.lot_no}`);
      } catch (e) {
        await conn.rollback();
        console.error(`  ROLLED BACK ${lb.lot_no}: ${e.message}`);
      }
    }
    // verify
    console.log('\nRe-checking for remaining offenders…');
    const remaining = await countOffenders(conn, LOT_FILTER);
    console.log(`  remaining cross-stage offenders: ${remaining}`);
  } else if (!APPLY) {
    console.log('\n(dry run — re-run with --apply to write)');
  }

  await conn.end();
}

/**
 * Build (but do not execute) the repair ops for one (lot, stage).
 * Returns [{summary, sql:[{q,p}], before}] — sql executed later in a txn.
 */
async function repairStage(conn, st, lot, cut, cutLabels, drows, dsizes, erows, esizes) {
  const ops = [];

  // group sizes
  const dsByRow = new Map(); drows.forEach(r => dsByRow.set(r.id, []));
  dsizes.forEach(s => { if (dsByRow.has(s.pid)) dsByRow.get(s.pid).push(s); });
  const esByEvt = new Map(); erows.forEach(r => esByEvt.set(r.id, []));
  esizes.forEach(s => { if (esByEvt.has(s.event_id)) esByEvt.get(s.event_id).push(s); });

  const sig = (sizes) => sizes.map(s => `${norm(s.size_label)}:${s.pieces}`).sort().join('|');
  const labelsDisjoint = (sizes) => sizes.length > 0 && sizes.every(s => !cutLabels.has(norm(s.size_label)));

  // VOID, don't DELETE: drop the size rows (no inbound FKs) and zero the
  // scalar, but keep the parent *_data / *_events row so child events
  // (parent_event_id) and finishing_dispatches references stay valid.
  const voidLegacy = (r) => [
    { q: `DELETE FROM ${st.dsz} WHERE ${st.fk}=?`, p: [r.id] },
    { q: `UPDATE ${st.data} SET total_pieces=0 WHERE id=?`, p: [r.id] },
  ];
  const voidEvent = (r) => [
    { q: `DELETE FROM ${st.evsz} WHERE event_id=?`, p: [r.id] },
    { q: `UPDATE ${st.ev} SET pieces=0 WHERE id=?`, p: [r.id] },
  ];

  // ---- 1) JUNK legacy rows ----
  const keptD = [];
  for (const r of drows) {
    const sizes = dsByRow.get(r.id) || [];
    if (labelsDisjoint(sizes)) {
      ops.push({
        summary: `void JUNK ${st.data}#${r.id} (labels ${sizes.map(s => s.size_label).join(',')})`,
        before: { row: r, sizes }, sql: voidLegacy(r),
      });
    } else keptD.push(r);
  }
  // ---- 1) JUNK events ----
  const keptE = [];
  for (const r of erows) {
    const sizes = esByEvt.get(r.id) || [];
    if (labelsDisjoint(sizes)) {
      ops.push({
        summary: `void JUNK ${st.ev}#${r.id} (${r.event_type}, labels ${sizes.map(s => s.size_label).join(',')})`,
        before: { row: r, sizes }, sql: voidEvent(r),
      });
    } else keptE.push(r);
  }

  // ---- 2) dedupe identical legacy rows ----
  const seenD = new Map();
  const keptD2 = [];
  for (const r of keptD) {
    const k = sig(dsByRow.get(r.id) || []);
    if (seenD.has(k)) {
      ops.push({
        summary: `void DUP ${st.data}#${r.id} (identical to #${seenD.get(k)})`,
        before: { row: r, sizes: dsByRow.get(r.id) }, sql: voidLegacy(r),
      });
    } else { seenD.set(k, r.id); keptD2.push(r); }
  }
  // ---- 2) dedupe identical events of the same type ----
  const seenE = new Map();
  const keptE2 = [];
  for (const r of keptE) {
    const k = r.event_type + '::' + sig(esByEvt.get(r.id) || []);
    if (seenE.has(k)) {
      ops.push({
        summary: `void DUP ${st.ev}#${r.id} (${r.event_type}, identical to #${seenE.get(k)})`,
        before: { row: r, sizes: esByEvt.get(r.id) }, sql: voidEvent(r),
      });
    } else { seenE.set(k, r.id); keptE2.push(r); }
  }

  // ---- 3) scale legacy breakdown to ceiling ----
  const legSizeItems = [];
  keptD2.forEach(r => (dsByRow.get(r.id) || []).forEach(s => legSizeItems.push({ key: s.id, pieces: Number(s.pieces), rowId: r.id })));
  const legTotal = legSizeItems.reduce((a, s) => a + s.pieces, 0);
  if (legTotal > cut) {
    const m = scaleToTarget(legSizeItems, cut);
    const sql = [];
    const newRowTotals = new Map(keptD2.map(r => [r.id, 0]));
    for (const it of legSizeItems) {
      const nv = m.get(it.key);
      newRowTotals.set(it.rowId, newRowTotals.get(it.rowId) + nv);
      if (nv === 0) sql.push({ q: `DELETE FROM ${st.dsz} WHERE id=?`, p: [it.key] });
      else if (nv !== it.pieces) sql.push({ q: `UPDATE ${st.dsz} SET pieces=? WHERE id=?`, p: [nv, it.key] });
    }
    for (const r of keptD2) sql.push({ q: `UPDATE ${st.data} SET total_pieces=? WHERE id=?`, p: [newRowTotals.get(r.id), r.id] });
    ops.push({ summary: `scale ${st.data} sizes ${legTotal}→${cut}`, before: { sizes: legSizeItems }, sql });
  }

  // ---- 3) scale each event_type (approve, complete) to ceiling ----
  for (const etype of ['approve', 'complete']) {
    const evs = keptE2.filter(r => r.event_type === etype);
    if (!evs.length) continue;
    const items = [];
    evs.forEach(r => (esByEvt.get(r.id) || []).forEach(s => items.push({ key: `${r.id}::${norm(s.size_label)}`, pieces: Number(s.pieces), evId: r.id, label: s.size_label })));
    const total = items.reduce((a, s) => a + s.pieces, 0);
    if (total > cut) {
      const m = scaleToTarget(items, cut);
      const sql = [];
      const newEvTotals = new Map(evs.map(r => [r.id, 0]));
      for (const it of items) {
        const nv = m.get(it.key);
        newEvTotals.set(it.evId, newEvTotals.get(it.evId) + nv);
        if (nv === 0) sql.push({ q: `DELETE FROM ${st.evsz} WHERE event_id=? AND size_label=?`, p: [it.evId, it.label] });
        else if (nv !== it.pieces) sql.push({ q: `UPDATE ${st.evsz} SET pieces=? WHERE event_id=? AND size_label=?`, p: [nv, it.evId, it.label] });
      }
      for (const r of evs) sql.push({ q: `UPDATE ${st.ev} SET pieces=? WHERE id=?`, p: [newEvTotals.get(r.id), r.id] });
      ops.push({ summary: `scale ${st.ev} ${etype} sizes ${total}→${cut}`, before: { sizes: items }, sql });
    }
  }

  return ops;
}

async function repairPayments(conn, lot, cut) {
  const [pays] = await conn.query(
    `SELECT id, stage, qty, base_rate, extra_amount, rate_configured, status, total_amount
     FROM stage_payments WHERE lot_no=? AND qty > ?`, [lot.lot_no, cut]
  );
  const ops = [];
  for (const p of pays) {
    // recompute amount: base_rate*cut + (per-piece extra)*cut, preserving rate flag
    const perPieceExtra = p.qty > 0 ? Number(p.extra_amount) / Number(p.qty) : 0;
    const newExtra = +(perPieceExtra * cut).toFixed(2);
    const newTotal = p.rate_configured ? +((Number(p.base_rate) * cut) + newExtra).toFixed(2) : 0;
    ops.push({
      summary: `clamp stage_payments#${p.id} (${p.stage}, ${p.status}) qty ${p.qty}→${cut}, amt ${p.total_amount}→${newTotal}`,
      before: { payment: p },
      sql: [{ q: `UPDATE stage_payments SET qty=?, extra_amount=?, total_amount=?, updated_at=NOW() WHERE id=?`, p: [cut, newExtra, newTotal, p.id] }],
    });
  }
  return ops;
}

// Run Query 1 of the diagnostic SQL file; return the offender lot_no list.
async function offenderLots(conn) {
  const file = path.join(__dirname, '..', 'sql', 'diagnostics', 'stage_qty_reconciliation.sql');
  const full = fs.readFileSync(file, 'utf8');
  const q1 = full.split(/;\s*\n/)[0]
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const [rows] = await conn.query(q1);
  return rows.map(r => r.lot_no);
}

async function countOffenders(conn, lotFilter) {
  const lots = await offenderLots(conn);
  return lotFilter ? lots.filter(l => l === lotFilter).length : lots.length;
}

main().catch(e => { console.error(e); process.exit(1); });
