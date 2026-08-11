/**
 * Lot Journey — one lot's status through EVERY production stage, ending at finishing
 * dispatch, on a single screen. Search by lot no / manual lot no / SKU.
 *
 * Data assembly lives in utils/lotJourneyData.js (shared with the read-only
 * lot viewer at /lot-view); this file is just the operator-facing routes.
 */

const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const {
  STAGE_LABEL, resolveLot, buildActivity, buildJourney,
} = require('../utils/lotJourneyData');

router.get('/', isAuthenticated, isOperator, (req, res) => res.render('lotJourney'));

router.get('/data', isAuthenticated, isOperator, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, matches: [], journey: null });
    const matches = await resolveLot(q);
    if (!matches.length) return res.json({ ok: true, matches: [], journey: null });
    const journey = await buildJourney(matches[0]);
    res.json({
      ok: true,
      journey,
      matches: matches.map((m) => ({
        id: m.id, lot_no: m.lot_no, manual_lot_number: m.manual_lot_number || '', sku: m.sku,
      })),
    });
  } catch (err) {
    console.error('GET /operator/lot-journey/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /export?q= — the same activity feed as the screen, as an Excel report.
// One row per update: date, time, flow, what happened, pieces, who, note.
router.get('/export', isAuthenticated, isOperator, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).send('Missing lot query (?q=)');
    const matches = await resolveLot(q);
    if (!matches.length) return res.status(404).send(`No lot found for "${q}"`);
    const lot = matches[0];
    const activity = await buildActivity(lot);

    const ACT_STAGE_LABEL = {
      ...STAGE_LABEL, dispatch: 'Dispatch', admin: 'Lot Admin',
    };
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Lot Activity');
    sheet.columns = [
      { header: 'Lot No',        key: 'lot_no',  width: 14 },
      { header: 'Manual Lot No', key: 'manual',  width: 14 },
      { header: 'SKU',           key: 'sku',     width: 22 },
      { header: 'Date',          key: 'date',    width: 13 },
      { header: 'Time',          key: 'time',    width: 10 },
      { header: 'Manual Date',   key: 'manual_date', width: 13 },
      { header: 'Flow',          key: 'flow',    width: 14 },
      { header: 'Update',        key: 'update',  width: 18 },
      { header: 'Pieces',        key: 'pieces',  width: 9 },
      { header: 'By',            key: 'by',      width: 16 },
      { header: 'Note',          key: 'note',    width: 40 },
    ];
    const dateOpts = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
    const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' };
    for (const a of activity) {
      sheet.addRow({
        lot_no: lot.lot_no, manual: lot.manual_lot_number || '', sku: lot.sku,
        date: new Date(a.when).toLocaleDateString('en-IN', dateOpts),
        time: new Date(a.when).toLocaleTimeString('en-IN', timeOpts),
        manual_date: a.manual_date ? new Date(a.manual_date).toLocaleDateString('en-IN', dateOpts) : '',
        flow: ACT_STAGE_LABEL[a.stage] || a.stage,
        update: a.label,
        pieces: a.pieces != null ? a.pieces : '',
        by: a.by || '', note: a.note || '',
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="LotActivity-${String(lot.lot_no).replace(/[^\w.-]/g, '_')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /operator/lot-journey/export error:', err);
    res.status(500).send('Failed to export lot activity');
  }
});

module.exports = router;
