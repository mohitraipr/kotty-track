// VMS status report — joins ee_shipments with vms_videos to find
// AWBs that shipped without a video, AWBs awaiting a video, etc.
//
// Computed (not stored) so it always reflects the current state — no flag
// to keep in sync.

const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isVideoCreator } = require('../middlewares/auth');

// Status the query produces:
//   video_created   — vms_videos row exists for this AWB
//   video_missing   — shipped/dispatched/delivered/RTO and no video
//   video_pending   — label printed, not yet shipped, no video
//   awb_not_ready   — fallback (label not printed yet)
const STATUS_CASE = `
  CASE
    WHEN v.id IS NOT NULL THEN 'video_created'
    WHEN s.current_status IN ('Shipped','Dispatched','Manifested','Delivered','Returned','RTO')
      THEN 'video_missing'
    WHEN s.label_printed_at IS NOT NULL THEN 'video_pending'
    ELSE 'awb_not_ready'
  END
`;

function buildWhereAndArgs(req) {
  const where = ["s.marketplace LIKE '%ajio%'"];
  const args = [];
  const days = Math.min(parseInt(req.query.days || '30', 10), 365);
  where.push('s.label_printed_at >= NOW() - INTERVAL ? DAY');
  args.push(days);
  if (req.query.warehouse_id) {
    where.push('s.warehouse_id = ?');
    args.push(req.query.warehouse_id);
  }
  return { where: where.join(' AND '), args, days };
}

router.get('/', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const { where, args, days } = buildWhereAndArgs(req);
    const [[summary]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END) AS video_created,
         SUM(CASE WHEN v.id IS NULL AND s.current_status IN
              ('Shipped','Dispatched','Manifested','Delivered','Returned','RTO') THEN 1 ELSE 0 END) AS video_missing,
         SUM(CASE WHEN v.id IS NULL AND s.label_printed_at IS NOT NULL AND s.current_status NOT IN
              ('Shipped','Dispatched','Manifested','Delivered','Returned','RTO') THEN 1 ELSE 0 END) AS video_pending
       FROM ee_shipments s
       LEFT JOIN vms_videos v ON v.awb = s.awb
       WHERE ${where}`,
      args
    );
    res.render('vmsReport', { user: req.session.user, summary, days, query: req.query });
  } catch (err) {
    console.error('VMS report error:', err);
    res.status(500).send('Report failed: ' + err.message);
  }
});

router.get('/api/rows', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const { where, args } = buildWhereAndArgs(req);
    const status = String(req.query.status || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);

    let extra = '';
    if (status === 'video_missing') {
      extra = ` AND v.id IS NULL AND s.current_status IN ('Shipped','Dispatched','Manifested','Delivered','Returned','RTO')`;
    } else if (status === 'video_pending') {
      extra = ` AND v.id IS NULL AND s.label_printed_at IS NOT NULL
               AND s.current_status NOT IN ('Shipped','Dispatched','Manifested','Delivered','Returned','RTO')`;
    } else if (status === 'video_created') {
      extra = ` AND v.id IS NOT NULL`;
    }

    const [rows] = await pool.query(
      `SELECT s.awb, s.order_id, s.reference_code, s.warehouse_id,
              s.current_status, s.label_printed_at, s.dispatched_at,
              s.delivered_at, s.rto_at,
              v.s3_key, v.created_at AS video_at, v.packer_name,
              ${STATUS_CASE} AS computed_status
         FROM ee_shipments s
         LEFT JOIN vms_videos v ON v.awb = s.awb
        WHERE ${where} ${extra}
        ORDER BY s.label_printed_at DESC
        LIMIT ?`,
      [...args, limit]
    );
    res.json({ ok: true, rows });
  } catch (err) {
    console.error('VMS report rows error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/export.xlsx', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const { where, args } = buildWhereAndArgs(req);
    const [rows] = await pool.query(
      `SELECT s.awb, s.order_id, s.reference_code, s.warehouse_id,
              s.current_status, s.label_printed_at, s.dispatched_at,
              s.delivered_at, s.rto_at,
              v.s3_key, v.created_at AS video_at, v.packer_name,
              ${STATUS_CASE} AS computed_status
         FROM ee_shipments s
         LEFT JOIN vms_videos v ON v.awb = s.awb
        WHERE ${where}
        ORDER BY s.label_printed_at DESC
        LIMIT 50000`,
      args
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('VMS report');
    ws.columns = [
      { header: 'AWB', key: 'awb', width: 22 },
      { header: 'Order ID', key: 'order_id', width: 14 },
      { header: 'Ajio Order #', key: 'reference_code', width: 22 },
      { header: 'Warehouse', key: 'warehouse_id', width: 12 },
      { header: 'Status', key: 'current_status', width: 14 },
      { header: 'Computed', key: 'computed_status', width: 16 },
      { header: 'Label Printed', key: 'label_printed_at', width: 20 },
      { header: 'Dispatched', key: 'dispatched_at', width: 20 },
      { header: 'Delivered', key: 'delivered_at', width: 20 },
      { header: 'Video Key', key: 's3_key', width: 50 },
      { header: 'Video At', key: 'video_at', width: 20 },
      { header: 'Packer', key: 'packer_name', width: 18 },
    ];
    rows.forEach((r) => ws.addRow(r));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="vms_report_${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('VMS report export error:', err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

module.exports = router;
