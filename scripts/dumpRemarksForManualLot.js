#!/usr/bin/env node
/**
 * Dump cutting lots whose handwritten/physical lot number was historically
 * typed into the free-text `remark` field, so the manual lot number can be
 * extracted and backfilled into the structured `manual_lot_number` column.
 *
 * READ-ONLY. Produces an Excel workbook with the candidate rows. The
 * `Manual Lot Number` column is left BLANK on purpose — it is filled in by
 * judgment (reading each remark), reviewed by a human, then fed to
 * scripts/backfillManualLotFromRemark.js to apply.
 *
 * Usage:
 *   node scripts/dumpRemarksForManualLot.js
 *   node scripts/dumpRemarksForManualLot.js --out /tmp/manual_lot_candidates.xlsx
 *   node scripts/dumpRemarksForManualLot.js --all   # include rows that already have a manual_lot_number
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');

function parseArgs(argv) {
  const args = { out: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage:\n' +
        '  node scripts/dumpRemarksForManualLot.js                 # candidates with a remark and blank manual_lot_number\n' +
        '  node scripts/dumpRemarksForManualLot.js --out FILE.xlsx # custom output path\n' +
        '  node scripts/dumpRemarksForManualLot.js --all           # include rows that already have manual_lot_number\n'
      );
      process.exit(0);
    }
  }
  return args;
}

function defaultOutPath() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(process.cwd(), `manual_lot_candidates_${d}.xlsx`);
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = args.out || defaultOutPath();

  const blankOnly = args.all
    ? ''
    : "AND (manual_lot_number IS NULL OR TRIM(manual_lot_number) = '')";

  const [rows] = await pool.query(
    `SELECT id, lot_no, manual_lot_number, sku, remark, created_at
       FROM cutting_lots
      WHERE remark IS NOT NULL AND TRIM(remark) <> ''
        ${blankOnly}
      ORDER BY created_at`
  );

  console.log(`Found ${rows.length} candidate lot(s) with a non-empty remark` +
    (args.all ? ' (including already-mapped).' : ' and blank manual_lot_number.'));

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Mapping'); // 'Mapping' so it's directly upload-compatible
  sheet.columns = [
    { header: 'System Lot No', key: 'lot_no', width: 18 },
    { header: 'Manual Lot Number', key: 'manual_lot_number', width: 22 }, // <- fill this
    { header: 'SKU', key: 'sku', width: 22 },
    { header: 'remark (source)', key: 'remark', width: 50 },
    { header: 'existing manual_lot_number', key: 'existing', width: 22 },
    { header: 'note', key: 'note', width: 26 },
    { header: 'created_at', key: 'created_at', width: 20 },
  ];

  for (const r of rows) {
    sheet.addRow({
      lot_no: r.lot_no,
      manual_lot_number: '', // intentionally blank — to be filled by judgment
      sku: r.sku || '',
      remark: r.remark || '',
      existing: r.manual_lot_number || '',
      note: '',
      created_at: r.created_at
        ? new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        : '',
    });
  }

  sheet.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath}`);
  console.log('Next: fill the "Manual Lot Number" column, then run scripts/backfillManualLotFromRemark.js');
}

main()
  .catch(err => { console.error('FATAL:', err); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch {} });
