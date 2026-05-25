#!/usr/bin/env node
/**
 * Fix orphan stage assignments.
 *
 * After the events-sourced migration (commit cdb1c4d), the legacy per-stage
 * approve UI was removed. Any *_assignments row with is_approved IS NULL is
 * now stuck: legacy dashboards gate on is_approved=1, and new reports read
 * from *_events with event_type='approve'. Neither side sees it.
 *
 * This script:
 *   1) inventories orphans across all 5 stages (dry-run by default),
 *   2) with --apply, sets is_approved=1, approved_on=NOW() on the row AND
 *      inserts a matching approve event (+ event_sizes from sizes_json).
 *
 * Usage:
 *   node scripts/fix-orphan-assignments.js
 *   node scripts/fix-orphan-assignments.js --lot AK5222
 *   node scripts/fix-orphan-assignments.js --apply
 *   node scripts/fix-orphan-assignments.js --apply --stage stitching
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../config/db');

// ─── Stage definitions ──────────────────────────────────────────────────
// flag column differs (stitching uses camelCase isApproved); event tables
// and size tables follow the *_events / *_event_sizes convention.
const STAGES = [
  {
    key: 'stitching',
    table: 'stitching_assignments',
    flagCol: 'isApproved',
    eventsTable: 'stitching_events',
    sizesTable: 'stitching_event_sizes',
  },
  {
    key: 'jeans_assembly',
    table: 'jeans_assembly_assignments',
    flagCol: 'is_approved',
    eventsTable: 'jeans_assembly_events',
    sizesTable: 'jeans_assembly_event_sizes',
  },
  {
    key: 'washing',
    table: 'washing_assignments',
    flagCol: 'is_approved',
    eventsTable: 'washing_events',
    sizesTable: 'washing_event_sizes',
  },
  {
    key: 'washing_in',
    table: 'washing_in_assignments',
    flagCol: 'is_approved',
    eventsTable: 'washing_in_events',
    sizesTable: 'washing_in_event_sizes',
  },
  {
    key: 'finishing',
    table: 'finishing_assignments',
    flagCol: 'is_approved',
    eventsTable: 'finishing_events',
    sizesTable: 'finishing_event_sizes',
  },
];

// ─── Arg parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { apply: false, stage: null, lot: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--stage') args.stage = argv[++i];
    else if (a === '--lot') args.lot = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage:\n' +
        '  node scripts/fix-orphan-assignments.js                  # dry-run\n' +
        '  node scripts/fix-orphan-assignments.js --lot AK5222     # inspect one lot\n' +
        '  node scripts/fix-orphan-assignments.js --apply          # fix all stages\n' +
        '  node scripts/fix-orphan-assignments.js --apply --stage stitching\n'
      );
      process.exit(0);
    }
  }
  return args;
}

// ─── Helpers ────────────────────────────────────────────────────────────
function parseSizesJson(raw) {
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const out = [];
  let total = 0;
  for (const [label, val] of Object.entries(obj)) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push({ label, pieces: Math.round(n) });
    total += Math.round(n);
  }
  if (out.length === 0) return null;
  return { rows: out, total };
}

// Each stage chains to cutting_lots differently. Returns SQL fragments
// resolving "cl.id" / "cl.lot_no" via the appropriate join chain.
function joinChainToCuttingLots(stageKey) {
  switch (stageKey) {
    case 'stitching':
      return { join: 'JOIN cutting_lots cl ON cl.id = a.cutting_lot_id', lotIdExpr: 'cl.id' };
    case 'jeans_assembly':
      return {
        join: 'JOIN stitching_assignments sa ON sa.id = a.stitching_assignment_id ' +
              'JOIN cutting_lots cl ON cl.id = sa.cutting_lot_id',
        lotIdExpr: 'cl.id',
      };
    case 'washing':
      return {
        join: 'JOIN jeans_assembly_assignments ja ON ja.id = a.jeans_assembly_assignment_id ' +
              'JOIN stitching_assignments sa ON sa.id = ja.stitching_assignment_id ' +
              'JOIN cutting_lots cl ON cl.id = sa.cutting_lot_id',
        lotIdExpr: 'cl.id',
      };
    case 'washing_in':
      // washing_in_assignments → washing_data (by id) → cutting_lots (by lot_no)
      return {
        join: 'JOIN washing_data wd ON wd.id = a.washing_data_id ' +
              'JOIN cutting_lots cl ON cl.lot_no = wd.lot_no',
        lotIdExpr: 'cl.id',
      };
    case 'finishing':
      // finishing_assignments can chain via 4 possible parents:
      //   washing_in_data_id  → washing_in_data.lot_no
      //   washing_in_assignment_id → washing_in_assignments.washing_data_id → washing_data.lot_no
      //   washing_assignment_id → washing_assignments → jeans_assembly_assignments → stitching_assignments.cutting_lot_id
      //   stitching_assignment_id → stitching_assignments.cutting_lot_id (hosiery)
      return {
        join:
          'LEFT JOIN washing_in_data wid ON wid.id = a.washing_in_data_id ' +
          'LEFT JOIN washing_in_assignments wia ON wia.id = a.washing_in_assignment_id ' +
          'LEFT JOIN washing_data wd2 ON wd2.id = wia.washing_data_id ' +
          'LEFT JOIN stitching_assignments sa2 ON sa2.id = a.stitching_assignment_id ' +
          'JOIN cutting_lots cl ON cl.lot_no = COALESCE(wid.lot_no, wd2.lot_no) OR cl.id = sa2.cutting_lot_id',
        lotIdExpr: 'cl.id',
      };
    default:
      throw new Error(`Unknown stage: ${stageKey}`);
  }
}

async function findOrphansForStage(conn, st, lotFilter) {
  const chain = joinChainToCuttingLots(st.key);
  let sql = `
    SELECT a.*, cl.lot_no AS _lot_no, cl.id AS _cl_id, cl.total_pieces AS _cl_total_pieces
      FROM \`${st.table}\` a
      ${chain.join}
     WHERE a.\`${st.flagCol}\` IS NULL`;
  const params = [];
  if (lotFilter) { sql += ' AND cl.lot_no = ?'; params.push(lotFilter); }
  sql += ' ORDER BY a.id';
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function existingApproveEvent(conn, st, cuttingLotId, operatorId, assignedOn) {
  const [rows] = await conn.query(
    `SELECT id FROM \`${st.eventsTable}\`
      WHERE event_type='approve'
        AND cutting_lot_id=?
        AND operator_id=?
        AND created_at <=> ?
      LIMIT 1`,
    [cuttingLotId, operatorId, assignedOn || null]
  );
  return rows.length ? rows[0].id : null;
}

// ─── Per-stage processing ───────────────────────────────────────────────
async function processStage(st, { apply, lotFilter }) {
  const summary = {
    stage: st.key, orphans: 0, approved: 0, eventsInserted: 0,
    sizeRows: 0, skippedDup: 0, errors: 0, sampleLots: [],
  };

  const conn = await pool.getConnection();
  try {
    const orphans = await findOrphansForStage(conn, st, lotFilter);
    summary.orphans = orphans.length;
    summary.sampleLots = orphans.slice(0, 5).map(r => r._lot_no);

    if (!apply) return summary;
    if (orphans.length === 0) return summary;

    await conn.beginTransaction();

    for (const row of orphans) {
      try {
        const aId        = row.id;
        const lotId      = row.cutting_lot_id || row._cl_id;
        const operatorId = row.user_id;
        const assignedOn = row.assigned_on || null;
        const sizes      = parseSizesJson(row.sizes_json);

        let pieces;
        if (sizes && sizes.total > 0) pieces = sizes.total;
        else if (Number(row.total_pieces) > 0) pieces = Number(row.total_pieces);
        else pieces = Number(row._cl_total_pieces) || 0;

        // 1) Flip the assignment flag.
        const [upd] = await conn.query(
          `UPDATE \`${st.table}\`
              SET \`${st.flagCol}\`=1, approved_on=COALESCE(approved_on, NOW())
            WHERE id=? AND \`${st.flagCol}\` IS NULL`,
          [aId]
        );
        if (upd.affectedRows === 1) summary.approved++;

        // 2) Skip event if one already exists for this (lot, operator, assignedOn).
        const existing = await existingApproveEvent(conn, st, lotId, operatorId, assignedOn);
        if (existing) { summary.skippedDup++; continue; }

        // 3) Insert approve event dated to assigned_on (so reports show
        //    the historical day, not today).
        const [ins] = await conn.query(
          `INSERT INTO \`${st.eventsTable}\`
             (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
           VALUES (?, 'approve', NULL, ?, ?, ?, COALESCE(?, NOW()))`,
          [lotId, pieces, operatorId, `AUTO_APPROVE_ORPHAN:${st.table}#${aId}`, assignedOn]
        );
        const eventId = ins.insertId;
        summary.eventsInserted++;

        // 4) Insert size rows if we parsed sizes_json successfully.
        if (sizes && sizes.rows.length) {
          const values = sizes.rows.map(s => [eventId, s.label, s.pieces]);
          await conn.query(
            `INSERT IGNORE INTO \`${st.sizesTable}\` (event_id, size_label, pieces) VALUES ?`,
            [values]
          );
          summary.sizeRows += sizes.rows.length;
        }
      } catch (e) {
        summary.errors++;
        console.error(`[${st.key}] row id=${row.id} lot=${row._lot_no} ERROR:`, e.message);
      }
    }

    if (summary.errors > 0) {
      await conn.rollback();
      console.error(`[${st.key}] rolled back due to ${summary.errors} error(s).`);
      summary.approved = 0; summary.eventsInserted = 0; summary.sizeRows = 0; summary.skippedDup = 0;
    } else {
      await conn.commit();
    }
  } catch (e) {
    try { await conn.rollback(); } catch {}
    summary.errors++;
    console.error(`[${st.key}] FATAL:`, e.message);
  } finally {
    conn.release();
  }
  return summary;
}

// ─── --lot mode: per-stage diagnostic for a single lot ──────────────────
async function diagnoseLot(lotNo) {
  console.log(`\n=== Lot diagnosis: ${lotNo} ===`);
  const conn = await pool.getConnection();
  try {
    const [lotRows] = await conn.query(
      'SELECT id, lot_no, sku, total_pieces, flow_type, user_id, created_at FROM cutting_lots WHERE lot_no = ?',
      [lotNo]
    );
    if (lotRows.length === 0) {
      console.log(`Lot ${lotNo} not found in cutting_lots.`);
      return;
    }
    const lot = lotRows[0];
    console.log(`cutting_lots: id=${lot.id} sku=${lot.sku} pieces=${lot.total_pieces} flow=${lot.flow_type} cutter=${lot.user_id} created=${lot.created_at && lot.created_at.toISOString ? lot.created_at.toISOString() : lot.created_at}`);

    for (const st of STAGES) {
      const [aRows] = await conn.query(
        `SELECT a.id, a.user_id, a.assigned_on, a.\`${st.flagCol}\` AS flag, a.approved_on, a.sizes_json
           FROM \`${st.table}\` a
          WHERE a.cutting_lot_id = ?`,
        [lot.id]
      );
      const [eRows] = await conn.query(
        `SELECT event_type, COUNT(*) AS c, SUM(pieces) AS pcs
           FROM \`${st.eventsTable}\`
          WHERE cutting_lot_id = ?
          GROUP BY event_type`,
        [lot.id]
      );
      const eMap = Object.fromEntries(eRows.map(r => [r.event_type, { c: r.c, pcs: r.pcs }]));
      console.log(`--- ${st.key} ---`);
      if (aRows.length === 0) {
        console.log(`  assignment: (none)`);
      } else {
        for (const a of aRows) {
          const sizes = parseSizesJson(a.sizes_json);
          console.log(`  assignment id=${a.id} user=${a.user_id} assigned_on=${a.assigned_on} flag=${a.flag === null ? 'NULL (ORPHAN)' : a.flag} approved_on=${a.approved_on || '—'} sizes_total=${sizes ? sizes.total : 'n/a'}`);
        }
      }
      const fmt = (k) => eMap[k] ? `${eMap[k].c} (${eMap[k].pcs} pcs)` : '0';
      console.log(`  events: approve=${fmt('approve')}  complete=${fmt('complete')}  reject=${fmt('reject')}`);
    }
  } finally {
    conn.release();
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────
function printSummary(summaries, { apply }) {
  if (!apply) {
    console.log('\nORPHAN INVENTORY (dry-run — no writes)\n');
    let total = 0;
    for (const s of summaries) {
      const sample = s.sampleLots.length ? ` (sample: ${s.sampleLots.join(', ')})` : '';
      console.log(`  ${s.stage.padEnd(16)} — ${String(s.orphans).padStart(5)} orphans${sample}`);
      total += s.orphans;
    }
    console.log('  ' + ' '.repeat(16) + '   ─────');
    console.log('  ' + ' '.repeat(16) + `   ${String(total).padStart(5)} total\n`);
    console.log('Re-run with --apply to fix.\n');
    return;
  }
  console.log('\nAPPLY RESULTS\n');
  console.log('  stage            orphans  approved  events  size_rows  skip(dup)  errors');
  for (const s of summaries) {
    console.log(
      '  ' +
      s.stage.padEnd(16) +
      String(s.orphans).padStart(8) +
      String(s.approved).padStart(10) +
      String(s.eventsInserted).padStart(8) +
      String(s.sizeRows).padStart(11) +
      String(s.skippedDup).padStart(11) +
      String(s.errors).padStart(8)
    );
  }
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.lot && !args.apply) {
    await diagnoseLot(args.lot);
    return;
  }

  const stagesToRun = args.stage
    ? STAGES.filter(s => s.key === args.stage)
    : STAGES;
  if (args.stage && stagesToRun.length === 0) {
    console.error(`Unknown stage: ${args.stage}. Valid: ${STAGES.map(s => s.key).join(', ')}`);
    process.exit(1);
  }

  if (args.apply) {
    console.log(`Applying orphan fix to: ${stagesToRun.map(s => s.key).join(', ')}${args.lot ? ` (lot=${args.lot})` : ''}`);
  } else {
    console.log(`Dry-run on: ${stagesToRun.map(s => s.key).join(', ')}${args.lot ? ` (lot=${args.lot})` : ''}`);
  }

  const summaries = [];
  for (const st of stagesToRun) {
    const s = await processStage(st, { apply: args.apply, lotFilter: args.lot });
    summaries.push(s);
  }
  printSummary(summaries, { apply: args.apply });

  if (args.lot) {
    await diagnoseLot(args.lot);
  }
}

main()
  .catch(err => { console.error('FATAL:', err); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch {} });
