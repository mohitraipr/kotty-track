/**
 * Stage Events utility — shared logic for the multi-batch
 * approve/complete/reject event model. Used by stitching, jeans
 * assembly, washing, washing-in, and finishing routes.
 *
 * Each stage has paired tables: {stage}_events + {stage}_event_sizes.
 * This module gives each route file a small set of functions that
 * speak in terms of stage NAMES (not table names) so the routes
 * stay symmetric.
 *
 * See sql/stage_events_migration.sql for the schema.
 */

const STAGES = ['stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing'];

function tablesFor(stage) {
  if (!STAGES.includes(stage)) {
    throw new Error(`Unknown stage: ${stage}`);
  }
  return {
    events: `${stage}_events`,
    eventSizes: `${stage}_event_sizes`,
  };
}

/**
 * Aggregate event totals for a single (lot, stage). Returns:
 *   { approved, completed, rejected, inline }
 * where inline = approved - completed - rejected.
 */
async function getStageAggregates(conn, stage, cuttingLotId) {
  const { events } = tablesFor(stage);
  const [rows] = await conn.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN event_type='approve'  THEN pieces END), 0) AS approved,
        COALESCE(SUM(CASE WHEN event_type='complete' THEN pieces END), 0) AS completed,
        COALESCE(SUM(CASE WHEN event_type='reject'   THEN pieces END), 0) AS rejected
      FROM ${events}
      WHERE cutting_lot_id = ?
    `,
    [cuttingLotId]
  );
  const r = rows[0] || {};
  const approved = Number(r.approved) || 0;
  const completed = Number(r.completed) || 0;
  const rejected = Number(r.rejected) || 0;
  return {
    approved,
    completed,
    rejected,
    inline: approved - completed - rejected,
  };
}

/**
 * Aggregate event totals broken down by size for a (lot, stage).
 * Returns a map: { 'M': { approved, completed, rejected, inline }, ... }
 */
async function getStageSizeAggregates(conn, stage, cuttingLotId) {
  const { events, eventSizes } = tablesFor(stage);
  const [rows] = await conn.query(
    `
      SELECT s.size_label,
             e.event_type,
             SUM(s.pieces) AS pieces
      FROM ${eventSizes} s
      JOIN ${events} e ON e.id = s.event_id
      WHERE e.cutting_lot_id = ?
      GROUP BY s.size_label, e.event_type
    `,
    [cuttingLotId]
  );
  const map = {};
  for (const row of rows) {
    const key = row.size_label;
    if (!map[key]) map[key] = { approved: 0, completed: 0, rejected: 0, inline: 0 };
    map[key][row.event_type] = Number(row.pieces) || 0;
  }
  for (const key of Object.keys(map)) {
    map[key].inline = map[key].approved - map[key].completed - map[key].rejected;
  }
  return map;
}

/**
 * List the open approve events at this stage — i.e., approve events
 * with positive remaining inline (not yet fully completed/rejected).
 * Used by the "complete" form to let an operator pick which approval
 * batch they're completing pieces against.
 */
async function getOpenApprovals(conn, stage, cuttingLotId) {
  const { events, eventSizes } = tablesFor(stage);
  const [approves] = await conn.query(
    `
      SELECT e.id, e.pieces AS approved, e.created_at, e.remark, u.username AS operator
      FROM ${events} e
      JOIN users u ON u.id = e.operator_id
      WHERE e.cutting_lot_id = ? AND e.event_type = 'approve'
      ORDER BY e.created_at ASC
    `,
    [cuttingLotId]
  );

  if (!approves.length) return [];

  const approveIds = approves.map(a => a.id);
  const [children] = await conn.query(
    `
      SELECT parent_event_id, event_type, SUM(pieces) AS pieces
      FROM ${events}
      WHERE parent_event_id IN (?)
      GROUP BY parent_event_id, event_type
    `,
    [approveIds]
  );

  const childMap = {};
  for (const c of children) {
    const id = c.parent_event_id;
    if (!childMap[id]) childMap[id] = { completed: 0, rejected: 0 };
    childMap[id][c.event_type] = Number(c.pieces) || 0;
  }

  // Pull size breakdowns per approve in one round trip
  const [sizes] = await conn.query(
    `
      SELECT s.event_id, s.size_label, s.pieces
      FROM ${eventSizes} s
      WHERE s.event_id IN (?)
    `,
    [approveIds]
  );
  const sizeMap = {};
  for (const s of sizes) {
    if (!sizeMap[s.event_id]) sizeMap[s.event_id] = {};
    sizeMap[s.event_id][s.size_label] = Number(s.pieces) || 0;
  }

  return approves
    .map(a => {
      const child = childMap[a.id] || { completed: 0, rejected: 0 };
      const inline = a.approved - child.completed - child.rejected;
      return {
        event_id: a.id,
        approved: a.approved,
        completed: child.completed,
        rejected: child.rejected,
        inline,
        approved_at: a.created_at,
        operator: a.operator,
        remark: a.remark,
        sizes: sizeMap[a.id] || {},
      };
    })
    .filter(a => a.inline > 0);
}

/**
 * Insert an event with its size breakdown atomically.
 *
 * params:
 *   - stage:           'stitching' | 'jeans_assembly' | etc.
 *   - cuttingLotId:    cutting_lots.id
 *   - eventType:       'approve' | 'complete' | 'reject'
 *   - operatorId:      users.id (the logged-in stage operator)
 *   - sizes:           [{ size_label, pieces }] — must sum to total
 *   - parentEventId:   required for complete/reject, must be NULL for approve
 *   - remark:          optional per-event note
 *
 * Returns the new event id.
 */
async function recordEvent(conn, {
  stage, cuttingLotId, eventType, operatorId, sizes, parentEventId = null, remark = null,
}) {
  const { events, eventSizes } = tablesFor(stage);

  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new Error('sizes must be a non-empty array');
  }
  const totalPieces = sizes.reduce((acc, s) => acc + (Number(s.pieces) || 0), 0);
  if (totalPieces <= 0) {
    throw new Error('Event must have positive total pieces');
  }
  if (eventType === 'approve' && parentEventId !== null) {
    throw new Error('approve events must not have a parent_event_id');
  }
  if ((eventType === 'complete' || eventType === 'reject') && parentEventId === null) {
    throw new Error(`${eventType} events require parent_event_id`);
  }

  const [result] = await conn.query(
    `
      INSERT INTO ${events}
        (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [cuttingLotId, eventType, parentEventId, totalPieces, operatorId, remark]
  );
  const eventId = result.insertId;

  const sizeRows = sizes
    .filter(s => Number(s.pieces) > 0)
    .map(s => [eventId, String(s.size_label), Number(s.pieces)]);
  if (sizeRows.length) {
    await conn.query(
      `INSERT INTO ${eventSizes} (event_id, size_label, pieces) VALUES ?`,
      [sizeRows]
    );
  }

  return eventId;
}

module.exports = {
  STAGES,
  tablesFor,
  getStageAggregates,
  getStageSizeAggregates,
  getOpenApprovals,
  recordEvent,
};
