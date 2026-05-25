/**
 * Shared rewash Excel export.
 *
 * exportRewashExcel(res, { washerId }) — if washerId is set, filters
 * rewash_requests.washer_id = washerId (washer's own view). Otherwise
 * exports every row (operator / washing-in master view).
 */

const ExcelJS = require('exceljs');
const { pool } = require('../config/db');

async function exportRewashExcel(res, { washerId } = {}) {
  let where = '';
  const params = [];
  if (washerId) { where = 'WHERE rr.washer_id = ?'; params.push(washerId); }

  const [rows] = await pool.query(
    `SELECT rr.id, rr.lot_no, rr.sku, rr.total_requested, rr.status,
            rr.created_at, rr.completed_at, rr.debit_id,
            wu.username  AS washer,
            wiu.username AS washing_in_master,
            cu.username  AS completed_by_name,
            cl.remark    AS cutting_remark
       FROM rewash_requests rr
  LEFT JOIN users wu  ON wu.id  = rr.washer_id
  LEFT JOIN users wiu ON wiu.id = rr.user_id
  LEFT JOIN users cu  ON cu.id  = rr.completed_by
  LEFT JOIN cutting_lots cl ON cl.lot_no = rr.lot_no
      ${where}
   ORDER BY rr.created_at DESC`,
    params
  );

  const rrIds = rows.map(r => r.id);
  const sizesByRR = {};
  if (rrIds.length) {
    const [sizeRows] = await pool.query(
      `SELECT rewash_request_id, size_label, pieces_requested
         FROM rewash_request_sizes
        WHERE rewash_request_id IN (?)
        ORDER BY size_label`,
      [rrIds]
    );
    for (const s of sizeRows) {
      (sizesByRR[s.rewash_request_id] = sizesByRR[s.rewash_request_id] || [])
        .push(`${s.size_label}:${s.pieces_requested}`);
    }
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Rewash Requests');
  sheet.columns = [
    { header: 'Lot No',           key: 'lot_no',          width: 14 },
    { header: 'SKU',              key: 'sku',             width: 22 },
    { header: 'Pieces',           key: 'total_requested', width: 10 },
    { header: 'Status',           key: 'status',          width: 12 },
    { header: 'Washer',           key: 'washer',          width: 18 },
    { header: 'Wash-In Master',   key: 'washing_in_master', width: 18 },
    { header: 'Sizes',            key: 'sizes',           width: 28 },
    { header: 'Cutting Remark',   key: 'cutting_remark',  width: 22 },
    { header: 'Requested On',     key: 'created_at',      width: 14 },
    { header: 'Completed By',     key: 'completed_by_name', width: 18 },
    { header: 'Completed On',     key: 'completed_at',    width: 14 },
    { header: 'Debit ID',         key: 'debit_id',        width: 10 },
  ];

  const fmt = d => d ? new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  }) : '';

  for (const r of rows) {
    sheet.addRow({
      lot_no: r.lot_no, sku: r.sku, total_requested: r.total_requested,
      status: r.status, washer: r.washer || '',
      washing_in_master: r.washing_in_master || '',
      sizes: (sizesByRR[r.id] || []).join(', '),
      cutting_remark: r.cutting_remark || '',
      created_at: fmt(r.created_at), completed_at: fmt(r.completed_at),
      completed_by_name: r.completed_by_name || '',
      debit_id: r.debit_id || '',
    });
  }

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  const scope = washerId ? 'MyRewash' : 'Rewash';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${scope}-${today}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { exportRewashExcel };
