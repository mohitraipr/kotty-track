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

// SQL enum values are present-tense ('approve','complete','reject') but the
// aggregate object uses past-tense keys ('approved','completed','rejected').
// Map between them when reading rows back.
const EVENT_TYPE_TO_KEY = {
  approve:  'approved',
  complete: 'completed',
  reject:   'rejected',
};

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
 *   { approved, completed, rejected, inline_rejected, upstream_rejected, inline }
 *
 *   - upstream_rejected: reject events with parent_event_id IS NULL (rejected
 *     at upstream handover; never entered this stage's pool — consumes upstream pool)
 *   - inline_rejected:   reject events with parent_event_id NOT NULL (rejected
 *     during this stage's processing — consumes a previous approve)
 *   - rejected = upstream_rejected + inline_rejected (back-compat)
 *   - inline   = approved - completed - inline_rejected (the WIP currently held)
 */
async function getStageAggregates(conn, stage, cuttingLotId) {
  const { events } = tablesFor(stage);
  const [rows] = await conn.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN event_type='approve'  THEN pieces END), 0) AS approved,
        COALESCE(SUM(CASE WHEN event_type='complete' THEN pieces END), 0) AS completed,
        COALESCE(SUM(CASE WHEN event_type='reject' AND parent_event_id IS NOT NULL THEN pieces END), 0) AS inline_rejected,
        COALESCE(SUM(CASE WHEN event_type='reject' AND parent_event_id IS NULL     THEN pieces END), 0) AS upstream_rejected
      FROM ${events}
      WHERE cutting_lot_id = ?
    `,
    [cuttingLotId]
  );
  const r = rows[0] || {};
  const approved          = Number(r.approved)          || 0;
  const completed         = Number(r.completed)         || 0;
  const inline_rejected   = Number(r.inline_rejected)   || 0;
  const upstream_rejected = Number(r.upstream_rejected) || 0;
  const rejected          = inline_rejected + upstream_rejected;
  return {
    approved,
    completed,
    rejected,
    inline_rejected,
    upstream_rejected,
    inline: approved - completed - inline_rejected,
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
             CASE WHEN e.parent_event_id IS NULL THEN 'u' ELSE 'i' END AS bucket,
             SUM(s.pieces) AS pieces
      FROM ${eventSizes} s
      JOIN ${events} e ON e.id = s.event_id
      WHERE e.cutting_lot_id = ?
      GROUP BY s.size_label, e.event_type, bucket
    `,
    [cuttingLotId]
  );
  const map = {};
  for (const row of rows) {
    // Normalize: trim + uppercase so that any whitespace/case drift between
    // tables (e.g. CHAR padding, "26" vs "26 ", "xl" vs "XL") doesn't break
    // downstream object-key lookups.
    const key = String(row.size_label || '').trim().toUpperCase();
    if (!key) continue;
    if (!map[key]) {
      map[key] = {
        approved: 0, completed: 0, rejected: 0,
        inline_rejected: 0, upstream_rejected: 0, inline: 0,
      };
    }
    const pieces = Number(row.pieces) || 0;
    const k = EVENT_TYPE_TO_KEY[row.event_type];
    if (!k) continue;
    map[key][k] = (map[key][k] || 0) + pieces;
    if (row.event_type === 'reject') {
      if (row.bucket === 'u') map[key].upstream_rejected += pieces;
      else                    map[key].inline_rejected   += pieces;
    }
  }
  for (const key of Object.keys(map)) {
    map[key].inline = map[key].approved - map[key].completed - map[key].inline_rejected;
  }
  return map;
}

// Normalization helper used by routes when looking up size aggregates
// by labels read from upstream tables (cutting_lot_sizes, etc.).
function normalizeSizeLabel(label) {
  return String(label || '').trim().toUpperCase();
}

/**
 * List the open approve events at this stage — i.e., approve events
 * with positive remaining inline (not yet fully completed/rejected).
 * Used by the "complete" form to let an operator pick which approval
 * batch they're completing pieces against.
 *
 * If `operatorId` is supplied, restricts to that operator's own approves —
 * enforces the owner-locked model where only the operator who approved
 * can complete/reject their own batch.
 */
async function getOpenApprovals(conn, stage, cuttingLotId, operatorId = null) {
  const { events, eventSizes } = tablesFor(stage);
  const params = [cuttingLotId];
  let operatorFilter = '';
  if (operatorId) {
    operatorFilter = 'AND e.operator_id = ?';
    params.push(operatorId);
  }
  const [approves] = await conn.query(
    `
      SELECT e.id, e.pieces AS approved, e.created_at, e.remark, u.username AS operator,
             e.operator_id
      FROM ${events} e
      JOIN users u ON u.id = e.operator_id
      WHERE e.cutting_lot_id = ? AND e.event_type = 'approve'
        ${operatorFilter}
      ORDER BY e.created_at ASC
    `,
    params
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
    const k = EVENT_TYPE_TO_KEY[c.event_type];
    if (k && (k === 'completed' || k === 'rejected')) {
      childMap[id][k] = Number(c.pieces) || 0;
    }
  }

  // Pull approve size breakdowns per approve in one round trip
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

  // Per-size pieces already consumed (completed OR rejected) against each
  // approve. Used to expose REMAINING per size so the "complete" form pre-fills
  // what's left to do, not the full approved amount. Both complete and reject
  // consume the approved pool (mirrors the server-side per-size cap).
  const [childSizes] = await conn.query(
    `
      SELECT e.parent_event_id, s.size_label, SUM(s.pieces) AS pieces
      FROM ${events} e
      JOIN ${eventSizes} s ON s.event_id = e.id
      WHERE e.parent_event_id IN (?)
        AND e.event_type IN ('complete','reject')
      GROUP BY e.parent_event_id, s.size_label
    `,
    [approveIds]
  );
  const childSizeMap = {};
  for (const cs of childSizes) {
    const pid = cs.parent_event_id;
    if (!childSizeMap[pid]) childSizeMap[pid] = {};
    childSizeMap[pid][cs.size_label] =
      (childSizeMap[pid][cs.size_label] || 0) + (Number(cs.pieces) || 0);
  }

  return approves
    .map(a => {
      const child = childMap[a.id] || { completed: 0, rejected: 0 };
      const inline = a.approved - child.completed - child.rejected;
      const approvedSizes = sizeMap[a.id] || {};
      const consumed = childSizeMap[a.id] || {};
      // Remaining per size; drop sizes with nothing left so the form shows only
      // what still needs completing.
      const remaining_sizes = {};
      for (const [label, qty] of Object.entries(approvedSizes)) {
        const rem = (Number(qty) || 0) - (consumed[label] || 0);
        if (rem > 0) remaining_sizes[label] = rem;
      }
      return {
        event_id: a.id,
        approved: a.approved,
        completed: child.completed,
        rejected: child.rejected,
        inline,
        approved_at: a.created_at,
        operator: a.operator,
        remark: a.remark,
        sizes: approvedSizes,
        remaining_sizes,
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
  if (eventType === 'complete' && parentEventId === null) {
    throw new Error('complete events require parent_event_id');
  }
  // reject events MAY be parentless: that's an "upstream reject" — pieces
  // refused at handover before they entered this stage's pool.

  // Guardrail: every size_label must belong to this lot's cutting breakdown.
  // Blocks malformed submissions (e.g. array-index labels '0','1','2'… that
  // historically produced phantom "+150" rows) and typo labels from ever
  // entering the event ledger — the single chokepoint for all stage events.
  const [cutRows] = await conn.query(
    `SELECT size_label FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
    [cuttingLotId]
  );
  if (cutRows.length) {
    const allowed = new Set(cutRows.map(r => normalizeSizeLabel(r.size_label)));
    const bad = [...new Set(sizes.map(s => normalizeSizeLabel(s.size_label)))]
      .filter(l => l && !allowed.has(l));
    if (bad.length) {
      throw new Error(
        `Invalid size label(s) [${bad.join(', ')}] not in cutting breakdown for lot ${cuttingLotId}. `
        + `If this screen has been open a long time, refresh the page (Ctrl+Shift+R) and try again.`
      );
    }
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
  normalizeSizeLabel,
};
