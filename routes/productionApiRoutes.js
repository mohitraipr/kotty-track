const express = require('express');
const router = express.Router();

const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');

const ALLOWED_ROLES = [
  'back_pocket',
  'stitching_master',
  'jeans_assembly',
  'washing',
  'washing_in',
  'finishing',
];

const ROLE_STAGE_MAP = {
  back_pocket: 'back_pocket',
  stitching_master: 'stitching_master',
  jeans_assembly: 'jeans_assembly',
  washing: 'washing',
  washing_in: 'washing_in',
  finishing: 'finishing',
};

const STAGES = Object.values(ROLE_STAGE_MAP);

function normaliseCode(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase();
}

function normaliseRemark(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function fetchBundleByCode(connection, bundleCode) {
  const [rows] = await connection.query(
    `SELECT b.id AS bundle_id,
            b.bundle_code,
            b.pieces_in_bundle,
            b.lot_id,
            l.lot_number
       FROM api_lot_bundles b
       INNER JOIN api_lots l ON l.id = b.lot_id
      WHERE b.bundle_code = ?
      LIMIT 1`,
    [bundleCode],
  );
  return rows[0] || null;
}

async function fetchPieceByCode(connection, pieceCode) {
  const [rows] = await connection.query(
    `SELECT p.id AS piece_id,
            p.piece_code,
            p.lot_id,
            b.id AS bundle_id,
            b.bundle_code,
            l.lot_number
       FROM api_lot_piece_codes p
       INNER JOIN api_lot_bundles b ON b.id = p.bundle_id
       INNER JOIN api_lots l ON l.id = p.lot_id
      WHERE p.piece_code = ?
      LIMIT 1`,
    [pieceCode],
  );
  return rows[0] || null;
}

async function fetchLotByNumber(connection, lotNumber) {
  const [rows] = await connection.query(
    `SELECT l.id AS lot_id,
            l.lot_number,
            l.total_pieces
       FROM api_lots l
      WHERE l.lot_number = ?
      LIMIT 1`,
    [lotNumber],
  );
  return rows[0] || null;
}

async function ensureNoDuplicate(connection, stage, codeValue) {
  const [rows] = await connection.query(
    `SELECT id
       FROM production_flow_events
      WHERE stage = ?
        AND code_value = ?
      LIMIT 1`,
    [stage, codeValue],
  );
  if (rows.length) {
    throw createHttpError(409, 'This code has already been submitted for this stage.');
  }
}

async function closeEvents(connection, { stage, lotId, bundleId, pieceId, closedByStage, closedByUserId, closedByUsername }) {
  const params = [];
  let whereClause = 'stage = ? AND is_closed = 0';
  params.push(stage);

  if (bundleId) {
    whereClause += ' AND bundle_id = ?';
    params.push(bundleId);
  } else if (pieceId) {
    whereClause += ' AND piece_id = ?';
    params.push(pieceId);
  } else {
    whereClause += ' AND lot_id = ?';
    params.push(lotId);
  }

  params.push(closedByStage, closedByUserId, closedByUsername);

  const [result] = await connection.query(
    `UPDATE production_flow_events
        SET is_closed = 1,
            closed_at = NOW(),
            closed_by_stage = ?,
            closed_by_user_id = ?,
            closed_by_user_username = ?
      WHERE ${whereClause}`,
    params,
  );

  return result.affectedRows;
}

async function insertEventRows(connection, rows) {
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await connection.query(
      `INSERT INTO production_flow_events
         (stage, code_type, code_value, lot_id, bundle_id, piece_id, lot_number, bundle_code, piece_code, pieces_total,
          user_id, user_username, user_role, remark)
       VALUES ?`,
      [chunk],
    );
  }
}

router.post(
  '/production-flow/entries',
  isAuthenticated,
  allowRoles(ALLOWED_ROLES),
  async (req, res) => {
    const user = req.session.user;
    const stage = ROLE_STAGE_MAP[user.roleName];
    if (!stage) {
      return res.status(403).json({ error: 'Your role cannot use this endpoint.' });
    }

    const rawCode = req.body.code;
    const remark = normaliseRemark(req.body.remark);
    const code = normaliseCode(rawCode);

    if (!code) {
      return res.status(400).json({ error: 'A valid code is required.' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (stage === 'back_pocket' || stage === 'stitching_master') {
        const bundle = await fetchBundleByCode(connection, code);
        if (!bundle) {
          throw createHttpError(404, 'Bundle code not found.');
        }

        await ensureNoDuplicate(connection, stage, code);

        await insertEventRows(connection, [[
          stage,
          'bundle',
          code,
          bundle.lot_id,
          bundle.bundle_id,
          null,
          bundle.lot_number,
          bundle.bundle_code,
          null,
          bundle.pieces_in_bundle,
          user.id,
          user.username,
          user.roleName,
          remark,
        ]]);

        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: bundle.lot_number,
            bundleCode: bundle.bundle_code,
            pieces: bundle.pieces_in_bundle,
          },
        });
      }

      if (stage === 'jeans_assembly') {
        const bundle = await fetchBundleByCode(connection, code);
        if (!bundle) {
          throw createHttpError(404, 'Bundle code not found.');
        }

        await ensureNoDuplicate(connection, stage, code);

        const [prereq] = await connection.query(
          `SELECT stage, is_closed
             FROM production_flow_events
            WHERE bundle_id = ?
              AND stage IN ('back_pocket','stitching_master')`,
          [bundle.bundle_id],
        );

        const hasBackPocket = prereq.some(row => row.stage === 'back_pocket' && row.is_closed === 0);
        const hasStitching = prereq.some(row => row.stage === 'stitching_master' && row.is_closed === 0);

        if (!hasBackPocket || !hasStitching) {
          throw createHttpError(409, 'Bundle must be submitted by both back_pocket and stitching_master before jeans assembly.');
        }

        await insertEventRows(connection, [[
          stage,
          'bundle',
          code,
          bundle.lot_id,
          bundle.bundle_id,
          null,
          bundle.lot_number,
          bundle.bundle_code,
          null,
          bundle.pieces_in_bundle,
          user.id,
          user.username,
          user.roleName,
          remark,
        ]]);

        const closed = await closeEvents(connection, {
          stage: 'back_pocket',
          bundleId: bundle.bundle_id,
          closedByStage: 'jeans_assembly',
          closedByUserId: user.id,
          closedByUsername: user.username,
        });

        const closed2 = await closeEvents(connection, {
          stage: 'stitching_master',
          bundleId: bundle.bundle_id,
          closedByStage: 'jeans_assembly',
          closedByUserId: user.id,
          closedByUsername: user.username,
        });

        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: bundle.lot_number,
            bundleCode: bundle.bundle_code,
            pieces: bundle.pieces_in_bundle,
            closedPrevious: closed + closed2,
          },
        });
      }

      if (stage === 'washing') {
        const lot = await fetchLotByNumber(connection, code);
        if (!lot) {
          throw createHttpError(404, 'Lot number not found.');
        }

        const [openJeans] = await connection.query(
          `SELECT COUNT(*) AS pending
             FROM production_flow_events
            WHERE stage = 'jeans_assembly'
              AND lot_id = ?
              AND is_closed = 0`,
          [lot.lot_id],
        );

        if (!openJeans[0].pending) {
          throw createHttpError(409, 'No open jeans assembly bundles remain for this lot.');
        }

        const [existing] = await connection.query(
          `SELECT COUNT(*) AS already
             FROM production_flow_events
            WHERE stage = 'washing'
              AND lot_id = ?`,
          [lot.lot_id],
        );

        if (existing[0].already) {
          throw createHttpError(409, 'This lot has already been processed for washing.');
        }

        const [pieces] = await connection.query(
          `SELECT p.id   AS piece_id,
                  p.piece_code,
                  p.bundle_id,
                  b.bundle_code
             FROM api_lot_piece_codes p
             INNER JOIN api_lot_bundles b ON b.id = p.bundle_id
            WHERE p.lot_id = ?`,
          [lot.lot_id],
        );

        if (!pieces.length) {
          throw createHttpError(409, 'No piece codes found for this lot.');
        }

        const rowsToInsert = pieces.map(piece => [
          'washing',
          'piece',
          piece.piece_code,
          lot.lot_id,
          piece.bundle_id,
          piece.piece_id,
          lot.lot_number,
          piece.bundle_code,
          piece.piece_code,
          1,
          user.id,
          user.username,
          user.roleName,
          remark,
        ]);

        await insertEventRows(connection, rowsToInsert);

        const closed = await closeEvents(connection, {
          stage: 'jeans_assembly',
          lotId: lot.lot_id,
          closedByStage: 'washing',
          closedByUserId: user.id,
          closedByUsername: user.username,
        });

        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: lot.lot_number,
            piecesRegistered: pieces.length,
            closedJeansAssembly: closed,
          },
        });
      }

      if (stage === 'washing_in') {
        const piece = await fetchPieceByCode(connection, code);
        if (!piece) {
          throw createHttpError(404, 'Piece code not found.');
        }

        await ensureNoDuplicate(connection, stage, code);

        const [washingEvents] = await connection.query(
          `SELECT id, is_closed
             FROM production_flow_events
            WHERE stage = 'washing'
              AND piece_id = ?
            LIMIT 1`,
          [piece.piece_id],
        );

        if (!washingEvents.length) {
          throw createHttpError(409, 'Washing stage entry missing for this piece.');
        }

        if (washingEvents[0].is_closed) {
          throw createHttpError(409, 'This piece is already closed for washing.');
        }

        await insertEventRows(connection, [[
          stage,
          'piece',
          code,
          piece.lot_id,
          piece.bundle_id,
          piece.piece_id,
          piece.lot_number,
          piece.bundle_code,
          piece.piece_code,
          1,
          user.id,
          user.username,
          user.roleName,
          remark,
        ]]);

        await closeEvents(connection, {
          stage: 'washing',
          pieceId: piece.piece_id,
          closedByStage: 'washing_in',
          closedByUserId: user.id,
          closedByUsername: user.username,
        });

        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: piece.lot_number,
            bundleCode: piece.bundle_code,
            pieceCode: piece.piece_code,
          },
        });
      }

      if (stage === 'finishing') {
        const bundle = await fetchBundleByCode(connection, code);
        if (!bundle) {
          throw createHttpError(404, 'Bundle code not found.');
        }

        await ensureNoDuplicate(connection, stage, code);

        const [[counts]] = await connection.query(
          `SELECT
              (SELECT COUNT(*) FROM api_lot_piece_codes WHERE bundle_id = ?) AS totalPieces,
              (SELECT COUNT(*) FROM production_flow_events WHERE stage = 'washing_in' AND bundle_id = ?) AS washingInPieces`,
          [bundle.bundle_id, bundle.bundle_id],
        );

        if (!counts.washingInPieces || counts.totalPieces !== counts.washingInPieces) {
          throw createHttpError(409, 'All pieces must be recorded in washing_in before finishing.');
        }

        await insertEventRows(connection, [[
          stage,
          'bundle',
          code,
          bundle.lot_id,
          bundle.bundle_id,
          null,
          bundle.lot_number,
          bundle.bundle_code,
          null,
          bundle.pieces_in_bundle,
          user.id,
          user.username,
          user.roleName,
          remark,
        ]]);

        const closed = await closeEvents(connection, {
          stage: 'washing_in',
          bundleId: bundle.bundle_id,
          closedByStage: 'finishing',
          closedByUserId: user.id,
          closedByUsername: user.username,
        });

        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: bundle.lot_number,
            bundleCode: bundle.bundle_code,
            pieces: bundle.pieces_in_bundle,
            washingInClosed: closed,
          },
        });
      }

      throw createHttpError(400, 'Unsupported stage.');
    } catch (error) {
      await connection.rollback();
      const status = error.status || 500;
      const message = error.message || 'Unable to process request.';
      if (status >= 500) {
        console.error('[production-flow] error:', error);
      }
      return res.status(status).json({ error: message });
    } finally {
      connection.release();
    }
  },
);

router.get(
  '/production-flow/bundles/:bundleCode',
  isAuthenticated,
  allowRoles(ALLOWED_ROLES),
  async (req, res) => {
    const bundleCode = normaliseCode(req.params.bundleCode);
    if (!bundleCode) {
      return res.status(400).json({ error: 'Bundle code is required.' });
    }

    try {
      const [rows] = await pool.query(
        `SELECT b.id AS bundleId,
                b.bundle_code AS bundleCode,
                b.pieces_in_bundle AS piecesInBundle,
                b.lot_id AS lotId,
                l.lot_number AS lotNumber,
                l.sku,
                l.fabric_type AS fabricType,
                COUNT(p.id) AS pieceCount
           FROM api_lot_bundles b
           INNER JOIN api_lots l ON l.id = b.lot_id
           LEFT JOIN api_lot_piece_codes p ON p.bundle_id = b.id
          WHERE b.bundle_code = ?
          GROUP BY b.id, b.bundle_code, b.pieces_in_bundle, b.lot_id, l.lot_number, l.sku, l.fabric_type`,
        [bundleCode],
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Bundle not found.' });
      }

      return res.json({ bundle: rows[0] });
    } catch (error) {
      console.error('[production-flow] bundle lookup error:', error);
      return res.status(500).json({ error: 'Failed to fetch bundle details.' });
    }
  },
);

router.get(
  '/production-flow/entries',
  isAuthenticated,
  allowRoles(ALLOWED_ROLES),
  async (req, res) => {
    const stageFilterRaw = req.query.stage;
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

    const stageFilter = stageFilterRaw ? stageFilterRaw.trim() : '';
    try {
      if (stageFilter) {
        if (!STAGES.includes(stageFilter)) {
          return res.status(400).json({ error: 'Invalid stage filter.' });
        }
        const [rows] = await pool.query(
          `SELECT id, stage, code_type AS codeType, code_value AS codeValue,
                  lot_id AS lotId, bundle_id AS bundleId, piece_id AS pieceId,
                  lot_number AS lotNumber, bundle_code AS bundleCode, piece_code AS pieceCode,
                  pieces_total AS piecesTotal,
                  user_id AS userId, user_username AS userUsername, user_role AS userRole,
                  remark, is_closed AS isClosed,
                  closed_by_stage AS closedByStage,
                  closed_by_user_id AS closedByUserId,
                  closed_by_user_username AS closedByUserUsername,
                  closed_at AS closedAt,
                  created_at AS createdAt,
                  updated_at AS updatedAt
             FROM production_flow_events
            WHERE stage = ?
            ORDER BY created_at DESC
            LIMIT ?`,
          [stageFilter, limit],
        );
        return res.json({ data: { [stageFilter]: rows }, limit });
      }

      const result = {};
      for (const stage of STAGES) {
        const [rows] = await pool.query(
          `SELECT id, stage, code_type AS codeType, code_value AS codeValue,
                  lot_id AS lotId, bundle_id AS bundleId, piece_id AS pieceId,
                  lot_number AS lotNumber, bundle_code AS bundleCode, piece_code AS pieceCode,
                  pieces_total AS piecesTotal,
                  user_id AS userId, user_username AS userUsername, user_role AS userRole,
                  remark, is_closed AS isClosed,
                  closed_by_stage AS closedByStage,
                  closed_by_user_id AS closedByUserId,
                  closed_by_user_username AS closedByUserUsername,
                  closed_at AS closedAt,
                  created_at AS createdAt,
                  updated_at AS updatedAt
             FROM production_flow_events
            WHERE stage = ?
            ORDER BY created_at DESC
            LIMIT ?`,
          [stage, limit],
        );
        result[stage] = rows;
      }

      return res.json({ data: result, limit });
    } catch (error) {
      console.error('[production-flow] entries fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch production flow entries.' });
    }
  },
);

module.exports = router;
