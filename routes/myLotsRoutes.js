/**
 * My Lots — universal lot-trace dashboard.
 *
 * One page, accessible to any authenticated user. Shows every cutting
 * lot the current user has touched (as cutter, stitching master,
 * assembly master, washing master, wash-in master, or finishing
 * master) with the full upstream + downstream chain of who handed it
 * off and who has it next.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

router.get('/', isAuthenticated, async (req, res) => {
  try {
    return res.render('myLots', { user: req.session.user });
  } catch (err) {
    console.error('GET /my-lots error:', err);
    return res.status(500).send('Failed to load My Lots');
  }
});

router.get('/data', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  try {
    // 1) Find every cutting_lot_id the current user touched — via legacy
    //    assignments OR via the new events tables. The events tables are
    //    authoritative now; a user can have events without an assignment.
    const [lotIdRows] = await pool.query(
      `
      SELECT id AS lot_id FROM cutting_lots WHERE user_id = ?
      UNION
      SELECT cutting_lot_id FROM stitching_assignments WHERE user_id = ?
      UNION
      SELECT sa.cutting_lot_id
        FROM jeans_assembly_assignments ja
        JOIN stitching_assignments sa ON sa.id = ja.stitching_assignment_id
       WHERE ja.user_id = ?
      UNION
      SELECT sa.cutting_lot_id
        FROM washing_assignments wa
        JOIN jeans_assembly_assignments ja ON ja.id = wa.jeans_assembly_assignment_id
        JOIN stitching_assignments sa ON sa.id = ja.stitching_assignment_id
       WHERE wa.user_id = ?
      UNION
      SELECT cl.id
        FROM washing_in_assignments wia
        JOIN washing_data wd ON wd.id = wia.washing_data_id
        JOIN cutting_lots cl ON cl.lot_no = wd.lot_no
       WHERE wia.user_id = ?
      UNION
      SELECT cl.id
        FROM finishing_assignments fa
        LEFT JOIN stitching_assignments sa2 ON sa2.id = fa.stitching_assignment_id
        LEFT JOIN washing_in_assignments wia2 ON wia2.id = fa.washing_in_assignment_id
        LEFT JOIN washing_data wd2 ON wd2.id = wia2.washing_data_id
        LEFT JOIN washing_in_data wid2 ON wid2.id = fa.washing_in_data_id
        JOIN cutting_lots cl ON cl.id = sa2.cutting_lot_id
                             OR cl.lot_no = wd2.lot_no
                             OR cl.lot_no = wid2.lot_no
       WHERE fa.user_id = ?
      UNION SELECT cutting_lot_id FROM stitching_events      WHERE operator_id = ?
      UNION SELECT cutting_lot_id FROM jeans_assembly_events WHERE operator_id = ?
      UNION SELECT cutting_lot_id FROM washing_events        WHERE operator_id = ?
      UNION SELECT cutting_lot_id FROM washing_in_events     WHERE operator_id = ?
      UNION SELECT cutting_lot_id FROM finishing_events      WHERE operator_id = ?
      `,
      [userId, userId, userId, userId, userId, userId,
       userId, userId, userId, userId, userId]
    );

    if (lotIdRows.length === 0) {
      return res.json({ user: req.session.user, lots: [] });
    }

    const lotIds = lotIdRows.map(r => r.lot_id).filter(x => x);
    if (lotIds.length === 0) {
      return res.json({ user: req.session.user, lots: [] });
    }

    // 2) Load lot metadata.
    const [lots] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.sku, cl.total_pieces, cl.flow_type, cl.created_at,
              cl.user_id AS cutter_id, cu.username AS cutter_name
         FROM cutting_lots cl
    LEFT JOIN users cu ON cu.id = cl.user_id
        WHERE cl.id IN (?)
     ORDER BY cl.created_at DESC
        LIMIT 1000`,
      [lotIds]
    );

    const lotById = {};
    const lotNos = [];
    for (const l of lots) {
      lotById[l.id] = {
        lot_id: l.id,
        lot_no: l.lot_no,
        sku: l.sku,
        pieces: Number(l.total_pieces) || 0,
        flow_type: l.flow_type || 'unknown',
        created_at: l.created_at,
        cutter: { user_id: l.cutter_id, name: l.cutter_name, is_me: l.cutter_id === userId },
        stitching: null,
        assembly: null,
        washing: null,
        washing_in: null,
        finishing: null,
        stitching_completed: false,
        assembly_completed: false,
        washing_completed: false,
        washing_in_completed: false,
        finishing_completed: false,
        current_stage: 'Stitching',
      };
      lotNos.push(l.lot_no);
    }

    // 3) Stitching assignments.
    const [saRows] = await pool.query(
      `SELECT sa.id, sa.cutting_lot_id, sa.user_id, su.username,
              sa.assigned_on, sa.isApproved AS is_approved, sa.approved_on
         FROM stitching_assignments sa
    LEFT JOIN users su ON su.id = sa.user_id
        WHERE sa.cutting_lot_id IN (?)`,
      [lotIds]
    );
    const saByLot = {};
    for (const r of saRows) {
      saByLot[r.cutting_lot_id] = r;
      const lot = lotById[r.cutting_lot_id];
      if (lot) {
        lot.stitching = {
          user_id: r.user_id, name: r.username, is_me: r.user_id === userId,
          assigned_on: r.assigned_on, approved: r.is_approved === 1,
          approved_on: r.approved_on,
        };
      }
    }

    // 4) Jeans assembly (denim only).
    const saIds = saRows.map(r => r.id);
    if (saIds.length) {
      const [jaRows] = await pool.query(
        `SELECT ja.id, ja.stitching_assignment_id, sa.cutting_lot_id, ja.user_id, ju.username,
                ja.assigned_on, ja.is_approved, ja.approved_on
           FROM jeans_assembly_assignments ja
           JOIN stitching_assignments sa ON sa.id = ja.stitching_assignment_id
      LEFT JOIN users ju ON ju.id = ja.user_id
          WHERE ja.stitching_assignment_id IN (?)`,
        [saIds]
      );
      const jaByLot = {};
      for (const r of jaRows) {
        jaByLot[r.cutting_lot_id] = r;
        const lot = lotById[r.cutting_lot_id];
        if (lot) {
          lot.assembly = {
            user_id: r.user_id, name: r.username, is_me: r.user_id === userId,
            assigned_on: r.assigned_on, approved: r.is_approved === 1,
            approved_on: r.approved_on,
          };
        }
      }

      // 5) Washing (denim only).
      const jaIds = jaRows.map(r => r.id);
      if (jaIds.length) {
        const [waRows] = await pool.query(
          `SELECT wa.id, wa.jeans_assembly_assignment_id, sa.cutting_lot_id,
                  wa.user_id, wu.username,
                  wa.assigned_on, wa.is_approved, wa.approved_on
             FROM washing_assignments wa
             JOIN jeans_assembly_assignments ja ON ja.id = wa.jeans_assembly_assignment_id
             JOIN stitching_assignments sa ON sa.id = ja.stitching_assignment_id
        LEFT JOIN users wu ON wu.id = wa.user_id
            WHERE wa.jeans_assembly_assignment_id IN (?)`,
          [jaIds]
        );
        for (const r of waRows) {
          const lot = lotById[r.cutting_lot_id];
          if (lot) {
            lot.washing = {
              user_id: r.user_id, name: r.username, is_me: r.user_id === userId,
              assigned_on: r.assigned_on, approved: r.is_approved === 1,
              approved_on: r.approved_on,
            };
          }
        }
      }
    }

    // 6) Washing-In (denim only) — chained via washing_data.lot_no.
    if (lotNos.length) {
      const [wiaRows] = await pool.query(
        `SELECT wia.id, wd.lot_no, wia.user_id, wu.username,
                wia.assigned_on, wia.is_approved, wia.approved_on
           FROM washing_in_assignments wia
           JOIN washing_data wd ON wd.id = wia.washing_data_id
      LEFT JOIN users wu ON wu.id = wia.user_id
          WHERE wd.lot_no IN (?)`,
        [lotNos]
      );
      const wiaByLotNo = {};
      for (const r of wiaRows) wiaByLotNo[r.lot_no] = r;
      for (const lot of Object.values(lotById)) {
        const r = wiaByLotNo[lot.lot_no];
        if (r) {
          lot.washing_in = {
            user_id: r.user_id, name: r.username, is_me: r.user_id === userId,
            assigned_on: r.assigned_on, approved: r.is_approved === 1,
            approved_on: r.approved_on,
          };
        }
      }
    }

    // 7) Finishing — can chain via stitching_assignment (hosiery), washing_in_data, or washing_in_assignment.
    const [faRows] = await pool.query(
      `SELECT fa.id, fa.user_id, fu.username,
              fa.assigned_on, fa.is_approved, fa.approved_on,
              sa.cutting_lot_id AS sa_lot_id,
              wid.lot_no AS wid_lot_no,
              wd2.lot_no AS wia_lot_no
         FROM finishing_assignments fa
    LEFT JOIN users fu ON fu.id = fa.user_id
    LEFT JOIN stitching_assignments sa ON sa.id = fa.stitching_assignment_id
    LEFT JOIN washing_in_data wid ON wid.id = fa.washing_in_data_id
    LEFT JOIN washing_in_assignments wia ON wia.id = fa.washing_in_assignment_id
    LEFT JOIN washing_data wd2 ON wd2.id = wia.washing_data_id
        WHERE sa.cutting_lot_id IN (?)
           OR wid.lot_no IN (?)
           OR wd2.lot_no IN (?)`,
      [lotIds.length ? lotIds : [0], lotNos.length ? lotNos : [''], lotNos.length ? lotNos : ['']]
    );
    for (const r of faRows) {
      let lot = null;
      if (r.sa_lot_id && lotById[r.sa_lot_id]) lot = lotById[r.sa_lot_id];
      else if (r.wid_lot_no) {
        for (const candidate of Object.values(lotById)) {
          if (candidate.lot_no === r.wid_lot_no) { lot = candidate; break; }
        }
      }
      else if (r.wia_lot_no) {
        for (const candidate of Object.values(lotById)) {
          if (candidate.lot_no === r.wia_lot_no) { lot = candidate; break; }
        }
      }
      if (lot && !lot.finishing) {
        lot.finishing = {
          user_id: r.user_id, name: r.username, is_me: r.user_id === userId,
          assigned_on: r.assigned_on, approved: r.is_approved === 1,
          approved_on: r.approved_on,
        };
      }
    }

    // 8) Events are the truth source for approve / complete state.
    //    For each stage we collect:
    //      - has approve event  → "approved"
    //      - has complete event → "completed"
    //      - latest operator + timestamp for either, so we can fill in
    //        stage data even when no legacy assignment row exists.
    const stageEventMap = [
      ['stitching_events',      'stitching'],
      ['jeans_assembly_events', 'assembly'],
      ['washing_events',        'washing'],
      ['washing_in_events',     'washing_in'],
      ['finishing_events',      'finishing'],
    ];
    for (const [t, stageKey] of stageEventMap) {
      const [rows] = await pool.query(
        `SELECT e.cutting_lot_id, e.event_type, e.operator_id, e.created_at, u.username
           FROM \`${t}\` e
      LEFT JOIN users u ON u.id = e.operator_id
          WHERE e.cutting_lot_id IN (?)
            AND e.event_type IN ('approve','complete')
          ORDER BY e.created_at DESC`,
        [lotIds]
      );
      // Group: per lot, latest approve + latest complete.
      const perLot = {};
      for (const r of rows) {
        const slot = perLot[r.cutting_lot_id] || (perLot[r.cutting_lot_id] = {});
        if (r.event_type === 'approve' && !slot.approve) slot.approve = r;
        if (r.event_type === 'complete' && !slot.complete) slot.complete = r;
      }
      for (const [lotIdStr, ev] of Object.entries(perLot)) {
        const lot = lotById[lotIdStr];
        if (!lot) continue;
        const approved  = !!ev.approve;
        const completed = !!ev.complete;
        if (stageKey === 'stitching')  lot.stitching_completed   = completed;
        if (stageKey === 'assembly')   lot.assembly_completed    = completed;
        if (stageKey === 'washing')    lot.washing_completed     = completed;
        if (stageKey === 'washing_in') lot.washing_in_completed  = completed;
        if (stageKey === 'finishing')  lot.finishing_completed   = completed;

        // If we have an assignment row, override its approved flag with
        // event truth. If no assignment row exists, synthesise stage data
        // from the latest approve/complete event so the timeline still
        // shows the master who actually did the work.
        const existing = lot[stageKey];
        const evOperator = ev.complete || ev.approve;
        if (existing) {
          existing.approved = approved || existing.approved;
          existing.completed = completed;
          if (approved && ev.approve) existing.approved_on = ev.approve.created_at;
          if (completed && ev.complete) existing.completed_on = ev.complete.created_at;
        } else if (evOperator) {
          lot[stageKey] = {
            user_id: evOperator.operator_id,
            name: evOperator.username,
            is_me: evOperator.operator_id === userId,
            assigned_on: ev.approve ? ev.approve.created_at : null,
            approved,
            approved_on: ev.approve ? ev.approve.created_at : null,
            completed,
            completed_on: ev.complete ? ev.complete.created_at : null,
            synthetic: true,
          };
        }
      }
    }

    // 9) Compute current_stage for each lot.
    for (const lot of Object.values(lotById)) {
      const isDenim = lot.flow_type === 'denim';
      const chain = isDenim
        ? ['stitching', 'assembly', 'washing', 'washing_in', 'finishing']
        : ['stitching', 'finishing'];
      const completedFlag = {
        stitching: 'stitching_completed',
        assembly: 'assembly_completed',
        washing: 'washing_completed',
        washing_in: 'washing_in_completed',
        finishing: 'finishing_completed',
      };
      let current = 'Done';
      for (const stage of chain) {
        if (lot[completedFlag[stage]]) continue;
        current = stage;
        break;
      }
      lot.current_stage = current;
    }

    // 10) Sort: newest first (already by created_at DESC from query).
    const result = Object.values(lotById).sort((a, b) => {
      const da = new Date(a.created_at).getTime();
      const db = new Date(b.created_at).getTime();
      return db - da;
    });

    return res.json({ user: req.session.user, lots: result });
  } catch (err) {
    console.error('GET /my-lots/data error:', err);
    return res.status(500).json({ error: 'Failed to load my-lots data' });
  }
});

module.exports = router;
