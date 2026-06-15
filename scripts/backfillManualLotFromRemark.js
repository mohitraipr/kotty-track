#!/usr/bin/env node
/**
 * Backfill cutting_lots.manual_lot_number from a reviewed mapping sheet
 * (System Lot No -> Manual Lot Number) that was extracted from the free-text
 * `remark` field by judgment and approved by a human.
 *
 * The mapping sheet is the workbook produced by
 * scripts/dumpRemarksForManualLot.js (sheet "Mapping": col A = System Lot No,
 * col B = Manual Lot Number) — the same shape the /manual-lot bulk upload reads,
 * so either file works.
 *
 * Behaviour:
 *   - DRY-RUN by default: prints exactly what it would change, writes nothing.
 *   - --apply actually writes, inside a transaction, and dumps a backup JSON of
 *     the prior values first.
 *   - Only fills BLANK manual_lot_number — never overwrites a value already set.
 *   - After cutting_lots, propagates the value onto historical challan snapshots
 *     (dc_challan_items) where those are still blank, so re-prints match.
 *
 * Usage:
 *   node scripts/backfillManualLotFromRemark.js --file manual_lot_candidates_2026-06-15.xlsx
 *   node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --lot AK5222   # test one lot
 *   node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --apply
 *   node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --apply --no-challans
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');

function parseArgs(argv) {
  const args = { file: null, apply: false, lot: null, challans: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--lot') args.lot = argv[++i];
    else if (a === '--no-challans') args.challans = false;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage:\n' +
        '  node scripts/backfillManualLotFromRemark.js --file FILE.xlsx            # dry-run\n' +
        '  node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --lot AK1  # one lot (dry-run)\n' +
        '  node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --apply    # write\n' +
        '  node scripts/backfillManualLotFromRemark.js --file FILE.xlsx --apply --no-challans\n'
      );
      process.exit(0);
    }
  }
  return args;
}

// Read the reviewed mapping: col 1 = System Lot No, col 2 = Manual Lot Number.
async function readMapping(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet('Mapping') || wb.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in the mapping file.');

  const out = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const cellText = v => (v == null ? '' : (v.text != null ? v.text : v).toString().trim());
    const lotNo = cellText(row.getCell(1).value);
    const manual = cellText(row.getCell(2).value);
    if (lotNo) out.push({ lot_no: lotNo, manual_lot_number: manual });
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('ERROR: --file <mapping.xlsx> is required. See --help.');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`ERROR: file not found: ${args.file}`);
    process.exit(1);
  }

  let mapping = await readMapping(args.file);
  if (args.lot) mapping = mapping.filter(m => m.lot_no === args.lot);

  const withValue = mapping.filter(m => m.manual_lot_number);
  const blankInSheet = mapping.length - withValue.length;
  console.log(`Mapping rows: ${mapping.length} (${withValue.length} with a manual lot number, ${blankInSheet} left blank/unmapped).`);

  if (withValue.length === 0) {
    console.log('Nothing to apply (no rows have a manual lot number filled in).');
    return;
  }

  const conn = await pool.getConnection();
  try {
    // Resolve current state for each lot so we only fill blanks and can report.
    const plan = [];
    for (const m of withValue) {
      const [crows] = await conn.query(
        'SELECT id, lot_no, manual_lot_number FROM cutting_lots WHERE lot_no = ?',
        [m.lot_no]
      );
      if (crows.length === 0) {
        plan.push({ ...m, status: 'NOT_FOUND' });
        continue;
      }
      // a lot_no should be unique, but handle dups defensively
      for (const c of crows) {
        const existing = (c.manual_lot_number || '').trim();
        if (existing && existing !== m.manual_lot_number) {
          plan.push({ ...m, id: c.id, existing, status: 'SKIP_HAS_VALUE' });
        } else if (existing === m.manual_lot_number) {
          plan.push({ ...m, id: c.id, existing, status: 'ALREADY_SET' });
        } else {
          plan.push({ ...m, id: c.id, existing: '', status: 'WILL_SET' });
        }
      }
    }

    const willSet   = plan.filter(p => p.status === 'WILL_SET');
    const skip      = plan.filter(p => p.status === 'SKIP_HAS_VALUE');
    const already   = plan.filter(p => p.status === 'ALREADY_SET');
    const notFound  = plan.filter(p => p.status === 'NOT_FOUND');

    console.log('\nPLAN (cutting_lots):');
    for (const p of willSet)  console.log(`  SET   ${p.lot_no.padEnd(14)} -> "${p.manual_lot_number}"`);
    for (const p of skip)     console.log(`  SKIP  ${p.lot_no.padEnd(14)} already has "${p.existing}" (sheet says "${p.manual_lot_number}")`);
    for (const p of already)  console.log(`  OK    ${p.lot_no.padEnd(14)} already "${p.existing}"`);
    for (const p of notFound) console.log(`  ???   ${p.lot_no.padEnd(14)} not found in cutting_lots`);

    console.log(`\nSummary: ${willSet.length} to set, ${skip.length} skipped (has value), ${already.length} already correct, ${notFound.length} not found.`);

    if (!args.apply) {
      console.log('\nDRY-RUN — no changes written. Re-run with --apply to write.');
      return;
    }
    if (willSet.length === 0) {
      console.log('\nNothing to write.');
      return;
    }

    // Backup prior state for the rows we are about to touch.
    const backupPath = path.join(
      process.cwd(),
      `manual_lot_backfill_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify({
      when: new Date().toISOString(),
      file: args.file,
      cutting_lots: willSet.map(p => ({ id: p.id, lot_no: p.lot_no, prior_manual_lot_number: null, new_manual_lot_number: p.manual_lot_number })),
    }, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    await conn.beginTransaction();
    let updated = 0;
    for (const p of willSet) {
      const [res] = await conn.query(
        `UPDATE cutting_lots SET manual_lot_number = ?
          WHERE lot_no = ? AND (manual_lot_number IS NULL OR TRIM(manual_lot_number) = '')`,
        [p.manual_lot_number, p.lot_no]
      );
      updated += res.affectedRows;
    }

    let challanUpdated = 0;
    if (args.challans) {
      // Propagate to historical challan snapshots where still blank.
      const lotNos = willSet.map(p => p.lot_no);
      const [res] = await conn.query(
        `UPDATE dc_challan_items dci
            JOIN cutting_lots cl ON cl.lot_no = dci.lot_no
             SET dci.manual_lot_number = cl.manual_lot_number
           WHERE dci.lot_no IN (?)
             AND (dci.manual_lot_number IS NULL OR TRIM(dci.manual_lot_number) = '')
             AND cl.manual_lot_number IS NOT NULL AND TRIM(cl.manual_lot_number) <> ''`,
        [lotNos]
      );
      challanUpdated = res.affectedRows;
    }

    await conn.commit();
    console.log(`\nAPPLIED: cutting_lots rows updated = ${updated}, dc_challan_items rows updated = ${challanUpdated}.`);
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('FAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
  }
}

main()
  .catch(err => { console.error('FATAL:', err); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch {} });
