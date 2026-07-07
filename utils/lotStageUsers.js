// Cross-stage "who handled this lot" for a single cutting lot.
//
// Returns the accountable operator for EVERY stage in the lot's flow (denim or hosiery),
// so any stage's search card can show "Cut by X · Stitched by Y · Washed by Z · Finished by W"
// instead of only the cutting master. The accountable operator for a stage is the operator of
// its first `approve` event (mirrors routes/lotJourneyRoutes.stageTiming); cutting comes from
// cutting_lots.user_id. Read-only, safe to call anywhere.

const { orderedStages } = require('./lotJourney');

const EVENT_TABLE = {
  stitching: 'stitching_events',
  jeans_assembly: 'jeans_assembly_events',
  washing: 'washing_events',
  washing_in: 'washing_in_events',
  finishing: 'finishing_events',
};

const STAGE_LABEL = {
  cutting: 'Cut',
  stitching: 'Stitch',
  jeans_assembly: 'Assembly',
  washing: 'Wash',
  washing_in: 'Wash-in',
  finishing: 'Finish',
};

// lot: { id, flow_type, cutter_name, created_at? }
// -> [{ stage, label, master, entered, completedAt, hasRows }] in flow order (cutting first).
async function getLotStageUsers(pool, lot) {
  const stages = orderedStages(lot && lot.flow_type);
  const out = [];
  for (const stage of stages) {
    if (stage === 'cutting') {
      out.push({
        stage, label: STAGE_LABEL.cutting,
        master: (lot && lot.cutter_name) || null,
        entered: (lot && lot.created_at) || null,
        completedAt: (lot && lot.created_at) || null,
        hasRows: true,
      });
      continue;
    }
    let master = null; let entered = null; let completedAt = null; let hasRows = false;
    try {
      const [rows] = await pool.query(
        `SELECT e.event_type, e.created_at, u.username
           FROM \`${EVENT_TABLE[stage]}\` e LEFT JOIN users u ON u.id = e.operator_id
          WHERE e.cutting_lot_id = ? ORDER BY e.created_at`,
        [lot.id]
      );
      hasRows = rows.length > 0;
      for (const r of rows) {
        if (!entered) entered = r.created_at;
        if (r.event_type === 'approve' && !master) master = r.username;
        if (r.event_type === 'complete') completedAt = r.created_at;
      }
    } catch (_) { /* stage table absent / query error -> leave stage blank */ }
    out.push({ stage, label: STAGE_LABEL[stage] || stage, master, entered, completedAt, hasRows });
  }
  return out;
}

module.exports = { getLotStageUsers, EVENT_TABLE, STAGE_LABEL };
