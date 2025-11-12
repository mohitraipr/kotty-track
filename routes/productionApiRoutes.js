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
const STAGES_REQUIRING_MASTER = new Set([
  'back_pocket',
  'stitching_master',
  'jeans_assembly',
  'finishing',
]);

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
            b.size_id,
            s.size_label,
            s.pattern_count,
            s.bundle_count,
            l.lot_number
       FROM api_lot_bundles b
       INNER JOIN api_lot_sizes s ON s.id = b.size_id
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
            b.size_id,
            s.size_label,
            l.lot_number
       FROM api_lot_piece_codes p
       INNER JOIN api_lot_bundles b ON b.id = p.bundle_id
       INNER JOIN api_lot_sizes s ON s.id = p.size_id
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

async function fetchLotWithSizes(connection, lotNumber) {
  const [rows] = await connection.query(
    `SELECT l.id AS lot_id,
            l.lot_number,
            l.total_pieces,
            s.id AS size_id,
            s.size_label,
            s.pattern_count,
            s.total_pieces AS size_total_pieces,
            s.bundle_count,
            b.id AS bundle_id,
            b.bundle_code,
            b.pieces_in_bundle,
            b.bundle_sequence
       FROM api_lots l
       INNER JOIN api_lot_sizes s ON s.lot_id = l.id
       LEFT JOIN api_lot_bundles b ON b.size_id = s.id
      WHERE l.lot_number = ?
      ORDER BY s.size_label, b.bundle_sequence`,
    [lotNumber],
  );

  if (!rows.length) {
    return null;
  }

  const lot = {
    lot_id: rows[0].lot_id,
    lot_number: rows[0].lot_number,
    total_pieces: rows[0].total_pieces,
    sizes: [],
  };

  const sizeMap = new Map();
  const labelMap = new Map();

  for (const row of rows) {
    let size = sizeMap.get(row.size_id);
    if (!size) {
      size = {
        size_id: row.size_id,
        size_label: row.size_label,
        pattern_count: row.pattern_count,
        total_pieces: row.size_total_pieces,
        bundle_count: row.bundle_count,
        bundles: [],
      };
      sizeMap.set(row.size_id, size);
      labelMap.set((row.size_label || '').toUpperCase(), size);
      lot.sizes.push(size);
    }

    if (row.bundle_id) {
      size.bundles.push({
        bundle_id: row.bundle_id,
        bundle_code: row.bundle_code,
        bundle_sequence: row.bundle_sequence,
        pieces_in_bundle: row.pieces_in_bundle,
      });
    }
  }

  lot.sizeMap = sizeMap;
  lot.sizeLabelMap = labelMap;
  return lot;
}

function parseSizeAssignments(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      parsed = trimmed.split(',').map(token => ({ sizeLabel: token.trim() }));
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map(entry => {
      if (!entry) return null;
      if (typeof entry === 'string') {
        return { sizeLabel: entry };
      }
      if (typeof entry === 'object') {
        return entry;
      }
      return null;
    })
    .filter(Boolean);
}

function parsePieceCodeList(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      parsed = trimmed.split(',');
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const unique = new Set();
  for (const item of parsed) {
    const code = normaliseCode(item);
    if (code) {
      unique.add(code);
    }
  }
  return Array.from(unique.values());
}

async function maybeResolveUserMaster(connection, userId, payload, { allowMissing = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    if (allowMissing) return null;
    return resolveUserMaster(connection, userId, {});
  }

  try {
    return await resolveUserMaster(connection, userId, payload);
  } catch (error) {
    if (allowMissing && error.status === 400) {
      return null;
    }
    throw error;
  }
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

async function closeEvents(
  connection,
  { stage, lotId, bundleId, pieceId, closedByStage, closedByUserId, closedByUsername },
) {
  const whereParams = [];
  let whereClause = 'stage = ? AND is_closed = 0';
  whereParams.push(stage);

  if (bundleId) {
    whereClause += ' AND bundle_id = ?';
    whereParams.push(bundleId);
  } else if (pieceId) {
    whereClause += ' AND piece_id = ?';
    whereParams.push(pieceId);
  } else {
    whereClause += ' AND lot_id = ?';
    whereParams.push(lotId);
  }

  const params = [closedByStage, closedByUserId, closedByUsername, ...whereParams];

  const [result] = await connection.query(
    `UPDATE production_flow_events
        SET is_closed = 1,
            event_status = 'closed',
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
  if (!rows.length) {
    return;
  }

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map(row => [
      row.stage,
      row.code_type ?? row.codeType,
      row.code_value ?? row.codeValue,
      row.lot_id ?? row.lotId,
      row.bundle_id ?? row.bundleId ?? null,
      row.size_id ?? row.sizeId ?? null,
      row.piece_id ?? row.pieceId ?? null,
      row.lot_number ?? row.lotNumber,
      row.bundle_code ?? row.bundleCode ?? null,
      row.size_label ?? row.sizeLabel ?? null,
      row.piece_code ?? row.pieceCode ?? null,
      row.pattern_count ?? row.patternCount ?? null,
      row.bundle_count ?? row.bundleCount ?? null,
      row.pieces_total ?? row.piecesTotal ?? null,
      row.user_id ?? row.userId,
      row.user_username ?? row.userUsername,
      row.user_role ?? row.userRole,
      row.master_id ?? row.masterId ?? null,
      row.master_name ?? row.masterName ?? null,
      row.remark ?? null,
      row.event_status ?? row.eventStatus ?? 'open',
      row.is_closed ? 1 : 0,
      row.closed_by_stage ?? row.closedByStage ?? null,
      row.closed_by_user_id ?? row.closedByUserId ?? null,
      row.closed_by_user_username ?? row.closedByUserUsername ?? null,
      row.closed_at ?? row.closedAt ?? null,
    ]);

    await connection.query(
      `INSERT INTO production_flow_events
         (stage, code_type, code_value, lot_id, bundle_id, size_id, piece_id,
          lot_number, bundle_code, size_label, piece_code, pattern_count, bundle_count, pieces_total,
          user_id, user_username, user_role, master_id, master_name, remark, event_status,
          is_closed, closed_by_stage, closed_by_user_id, closed_by_user_username, closed_at)
       VALUES ?`,
      [chunk],
    );
  }
}

async function insertRejectionEvents(connection, stage, user, pieceCodes, remark) {
  if (!pieceCodes.length) {
    return { inserted: 0, codes: [], pieces: [] };
  }

  const [pieces] = await connection.query(
    `SELECT p.id AS piece_id,
            p.piece_code,
            p.lot_id,
            p.size_id,
            p.bundle_id,
            b.bundle_code,
            s.size_label,
            l.lot_number
       FROM api_lot_piece_codes p
       INNER JOIN api_lot_bundles b ON b.id = p.bundle_id
       INNER JOIN api_lot_sizes s ON s.id = p.size_id
       INNER JOIN api_lots l ON l.id = p.lot_id
      WHERE p.piece_code IN (?)`,
    [pieceCodes],
  );

  if (!pieces.length) {
    throw createHttpError(404, 'No matching piece codes were found for rejection.');
  }

  const foundCodes = new Set(pieces.map(p => p.piece_code));
  const missing = pieceCodes.filter(code => !foundCodes.has(code));
  if (missing.length) {
    throw createHttpError(404, `Piece codes not found: ${missing.join(', ')}`);
  }

  const pieceIds = pieces.map(p => p.piece_id);
  const [existing] = await connection.query(
    `SELECT piece_id
       FROM production_flow_events
      WHERE stage = ?
        AND piece_id IN (?)`,
    [stage, pieceIds],
  );

  if (existing.length) {
    const existingIds = new Set(existing.map(row => row.piece_id));
    const duplicates = pieces
      .filter(p => existingIds.has(p.piece_id))
      .map(p => p.piece_code);
    throw createHttpError(
      409,
      `Piece codes already submitted for ${stage}: ${duplicates.join(', ')}`,
    );
  }

  const now = new Date();
  const rows = pieces.map(piece => ({
    stage,
    code_type: 'piece',
    code_value: piece.piece_code,
    lot_id: piece.lot_id,
    bundle_id: piece.bundle_id,
    size_id: piece.size_id,
    piece_id: piece.piece_id,
    lot_number: piece.lot_number,
    bundle_code: piece.bundle_code,
    size_label: piece.size_label,
    piece_code: piece.piece_code,
    pieces_total: 1,
    user_id: user.id,
    user_username: user.username,
    user_role: user.roleName,
    master_id: null,
    master_name: null,
    remark,
    event_status: 'rejected',
    is_closed: true,
    closed_by_stage: stage,
    closed_by_user_id: user.id,
    closed_by_user_username: user.username,
    closed_at: now,
  }));

  await insertEventRows(connection, rows);
  return { inserted: rows.length, codes: pieceCodes, pieces };
}

function parseMasterId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(400, 'Invalid masterId provided.');
  }

  return parsed;
}

function normaliseMasterName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

async function resolveUserMaster(connection, userId, payload) {
  const masterIdRaw =
    payload.masterId ??
    payload.master_id ??
    payload.masterID;
  const masterNameRaw =
    payload.masterName ??
    payload.master_name ??
    payload.mastername ??
    payload.master;

  const masterId = parseMasterId(masterIdRaw);
  const masterName = normaliseMasterName(masterNameRaw);

  if (!masterId && !masterName) {
    throw createHttpError(400, 'Master selection is required for this stage.');
  }

  let query;
  let params;

  if (masterId) {
    query =
      'SELECT id, master_name FROM user_masters WHERE id = ? AND creator_user_id = ? LIMIT 1';
    params = [masterId, userId];
  } else {
    query =
      'SELECT id, master_name FROM user_masters WHERE creator_user_id = ? AND master_name = ? LIMIT 1';
    params = [userId, masterName];
  }

  const [rows] = await connection.query(query, params);

  if (!rows.length) {
    throw createHttpError(404, 'Selected master was not found for the current user.');
  }

  return { masterId: rows[0].id, masterName: rows[0].master_name };
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
    const stageRequiresMaster = STAGES_REQUIRING_MASTER.has(stage);
    const rejectedPiecesInput =
      stage === 'jeans_assembly' || stage === 'washing_in'
        ? parsePieceCodeList(
            req.body.rejectedPieces ??
              req.body.rejectPieces ??
              req.body.rejected_piece_codes ??
              req.body.rejectedPieceCodes ??
              req.body.reject_piece_codes ??
              [],
          )
        : [];

    if (!code && rejectedPiecesInput.length === 0) {
      return res.status(400).json({ error: 'A valid code is required.' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (stage === 'back_pocket' || stage === 'stitching_master') {
        const lot = await fetchLotWithSizes(connection, code);
        if (!lot) {
          throw createHttpError(404, 'Lot code not found.');
        }

        const assignmentsRaw =
          req.body.assignments ??
          req.body.sizeAssignments ??
          req.body.sizes ??
          req.body.size_ids ??
          req.body.sizeIds;

        let assignments = parseSizeAssignments(assignmentsRaw);
        const defaultMaster = stageRequiresMaster
          ? await maybeResolveUserMaster(connection, user.id, req.body, { allowMissing: true })
          : { masterId: null, masterName: null };

        if (!assignments.length) {
          assignments = lot.sizes.map(size => ({ sizeId: size.size_id }));
        }

        if (!assignments.length) {
          throw createHttpError(400, 'No sizes found to assign for this lot.');
        }

        const usedSizeIds = new Set();
        const eventRows = [];
        const summary = [];
        const bundleCodeMap = new Map();

        for (const assignment of assignments) {
          const sizeIdRaw = assignment.sizeId ?? assignment.size_id ?? assignment.id;
          const sizeLabelRaw = assignment.sizeLabel ?? assignment.size_label ?? assignment.size;

          let size = null;
          if (sizeIdRaw !== undefined && sizeIdRaw !== null && sizeIdRaw !== '') {
            const sizeId = Number.parseInt(sizeIdRaw, 10);
            if (!Number.isInteger(sizeId)) {
              throw createHttpError(400, 'Invalid sizeId provided in assignments.');
            }
            size = lot.sizeMap.get(sizeId) || null;
          } else if (sizeLabelRaw) {
            const normalised = normaliseCode(sizeLabelRaw);
            if (normalised) {
              size = lot.sizeLabelMap.get(normalised) || null;
            }
          }

          if (!size) {
            throw createHttpError(404, 'One or more sizes were not found in this lot.');
          }

          if (usedSizeIds.has(size.size_id)) {
            throw createHttpError(
              409,
              `Size ${size.size_label} has been provided multiple times in the request.`,
            );
          }

          let masterDetails = { masterId: null, masterName: null };
          if (stageRequiresMaster) {
            masterDetails =
              (await maybeResolveUserMaster(connection, user.id, assignment, { allowMissing: true })) ||
              defaultMaster;

            if (!masterDetails || (!masterDetails.masterId && !masterDetails.masterName)) {
              throw createHttpError(
                400,
                `Master selection is required for size ${size.size_label}.`,
              );
            }
          }

          if (!Array.isArray(size.bundles) || !size.bundles.length) {
            throw createHttpError(
              409,
              `No bundles were generated for size ${size.size_label}.`,
            );
          }

          usedSizeIds.add(size.size_id);
          summary.push({
            sizeId: size.size_id,
            sizeLabel: size.size_label,
            bundles: size.bundles.length,
            masterId: masterDetails.masterId ?? null,
            masterName: masterDetails.masterName ?? null,
          });

          for (const bundle of size.bundles) {
            eventRows.push({
              stage,
              code_type: 'bundle',
              code_value: bundle.bundle_code,
              lot_id: lot.lot_id,
              bundle_id: bundle.bundle_id,
              size_id: size.size_id,
              lot_number: lot.lot_number,
              bundle_code: bundle.bundle_code,
              size_label: size.size_label,
              pattern_count: size.pattern_count,
              bundle_count: size.bundle_count,
              pieces_total: bundle.pieces_in_bundle,
              user_id: user.id,
              user_username: user.username,
              user_role: user.roleName,
              master_id: masterDetails.masterId ?? null,
              master_name: masterDetails.masterName ?? null,
              remark,
            });
            bundleCodeMap.set(bundle.bundle_id, bundle.bundle_code);
          }
        }

        if (!eventRows.length) {
          throw createHttpError(400, 'No bundle assignments could be generated for this request.');
        }

        const bundleIds = Array.from(new Set(eventRows.map(r => r.bundle_id).filter(Boolean)));
        if (bundleIds.length) {
          const [existing] = await connection.query(
            `SELECT bundle_id
               FROM production_flow_events
              WHERE stage = ?
                AND bundle_id IN (?)`,
            [stage, bundleIds],
          );

          if (existing.length) {
            const duplicates = existing
              .map(row => bundleCodeMap.get(row.bundle_id))
              .filter(Boolean);
            throw createHttpError(
              409,
              `Bundles already submitted for this stage: ${duplicates.join(', ')}`,
            );
          }
        }

        await insertEventRows(connection, eventRows);
        await connection.commit();

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: lot.lot_number,
            assignments: summary,
          },
        });
      }

      const masterDetails = stageRequiresMaster
        ? await resolveUserMaster(connection, user.id, req.body)
        : { masterId: null, masterName: null };

      if (stage === 'jeans_assembly') {
        let bundle = null;
        let closedBackPocket = 0;
        let closedStitching = 0;

        if (code) {
          bundle = await fetchBundleByCode(connection, code);
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

          await insertEventRows(connection, [{
            stage,
            code_type: 'bundle',
            code_value: code,
            lot_id: bundle.lot_id,
            bundle_id: bundle.bundle_id,
            size_id: bundle.size_id,
            lot_number: bundle.lot_number,
            bundle_code: bundle.bundle_code,
            size_label: bundle.size_label,
            pattern_count: bundle.pattern_count,
            bundle_count: bundle.bundle_count,
            pieces_total: bundle.pieces_in_bundle,
            user_id: user.id,
            user_username: user.username,
            user_role: user.roleName,
            master_id: masterDetails.masterId,
            master_name: masterDetails.masterName,
            remark,
          }]);

          closedBackPocket = await closeEvents(connection, {
            stage: 'back_pocket',
            bundleId: bundle.bundle_id,
            closedByStage: 'jeans_assembly',
            closedByUserId: user.id,
            closedByUsername: user.username,
          });

          closedStitching = await closeEvents(connection, {
            stage: 'stitching_master',
            bundleId: bundle.bundle_id,
            closedByStage: 'jeans_assembly',
            closedByUserId: user.id,
            closedByUsername: user.username,
          });
        }

        let rejectionResult = { inserted: 0, codes: [], pieces: [] };
        if (rejectedPiecesInput.length) {
          rejectionResult = await insertRejectionEvents(
            connection,
            stage,
            user,
            rejectedPiecesInput,
            remark,
          );
        }

        if (!bundle && rejectionResult.inserted === 0) {
          throw createHttpError(400, 'Bundle code or rejected piece codes are required.');
        }

        await connection.commit();

        const responseLotNumber = bundle
          ? bundle.lot_number
          : rejectionResult.pieces[0]?.lot_number || null;
        const responseBundleCode = bundle ? bundle.bundle_code : null;
        const responsePieces = bundle ? bundle.pieces_in_bundle : null;

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: responseLotNumber,
            bundleCode: responseBundleCode,
            pieces: responsePieces,
            masterId: masterDetails.masterId,
            masterName: masterDetails.masterName,
            rejectedPieces: rejectionResult.codes,
            closedBackPocket,
            closedStitching,
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

        if (existing[0].already >= lot.total_pieces) {
          throw createHttpError(409, 'This lot has already been processed for washing.');
        }

        const [pieces] = await connection.query(
          `SELECT DISTINCT p.id   AS piece_id,
                          p.piece_code,
                          p.bundle_id,
                          p.size_id,
                          s.size_label,
                          b.bundle_code
             FROM api_lot_piece_codes p
             INNER JOIN api_lot_bundles b
                     ON b.id = p.bundle_id
             INNER JOIN api_lot_sizes s
                     ON s.id = p.size_id
             INNER JOIN production_flow_events je
                     ON je.bundle_id = p.bundle_id
                    AND je.stage = 'jeans_assembly'
                    AND je.is_closed = 0
            WHERE p.lot_id = ?`,
          [lot.lot_id],
        );

        if (!pieces.length) {
          throw createHttpError(
            409,
            'No open jeans assembly bundles available to close for this lot.',
          );
        }

        const rowsToInsert = pieces.map(piece => ({
          stage: 'washing',
          code_type: 'piece',
          code_value: piece.piece_code,
          lot_id: lot.lot_id,
          bundle_id: piece.bundle_id,
          size_id: piece.size_id,
          piece_id: piece.piece_id,
          lot_number: lot.lot_number,
          bundle_code: piece.bundle_code,
          size_label: piece.size_label,
          piece_code: piece.piece_code,
          pieces_total: 1,
          user_id: user.id,
          user_username: user.username,
          user_role: user.roleName,
          master_id: null,
          master_name: null,
          remark,
        }));

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
        const piece = code ? await fetchPieceByCode(connection, code) : null;
        if (code && !piece) {
          throw createHttpError(404, 'Piece code not found.');
        }

        if (piece) {
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

          await insertEventRows(connection, [{
            stage,
            code_type: 'piece',
            code_value: code,
            lot_id: piece.lot_id,
            bundle_id: piece.bundle_id,
            size_id: piece.size_id,
            piece_id: piece.piece_id,
            lot_number: piece.lot_number,
            bundle_code: piece.bundle_code,
            size_label: piece.size_label,
            piece_code: piece.piece_code,
            pieces_total: 1,
            user_id: user.id,
            user_username: user.username,
            user_role: user.roleName,
            master_id: null,
            master_name: null,
            remark,
          }]);

          await closeEvents(connection, {
            stage: 'washing',
            pieceId: piece.piece_id,
            closedByStage: 'washing_in',
            closedByUserId: user.id,
            closedByUsername: user.username,
          });
        }

        let rejectionResult = { inserted: 0, codes: [], pieces: [] };
        if (rejectedPiecesInput.length) {
          rejectionResult = await insertRejectionEvents(
            connection,
            stage,
            user,
            rejectedPiecesInput,
            remark,
          );

          for (const rejected of rejectionResult.pieces) {
            await closeEvents(connection, {
              stage: 'washing',
              pieceId: rejected.piece_id,
              closedByStage: 'washing_in',
              closedByUserId: user.id,
              closedByUsername: user.username,
            });
          }
        }

        if (!piece && rejectionResult.inserted === 0) {
          throw createHttpError(400, 'Piece code or rejected piece codes are required.');
        }

        await connection.commit();

        const responseLotNumber = piece
          ? piece.lot_number
          : rejectionResult.pieces[0]?.lot_number || null;
        const responseBundleCode = piece ? piece.bundle_code : null;
        const responsePieceCode = piece ? piece.piece_code : null;

        return res.json({
          success: true,
          stage,
          data: {
            lotNumber: responseLotNumber,
            bundleCode: responseBundleCode,
            pieceCode: responsePieceCode,
            rejectedPieces: rejectionResult.codes,
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

        await insertEventRows(connection, [{
          stage,
          code_type: 'bundle',
          code_value: code,
          lot_id: bundle.lot_id,
          bundle_id: bundle.bundle_id,
          size_id: bundle.size_id,
          lot_number: bundle.lot_number,
          bundle_code: bundle.bundle_code,
          size_label: bundle.size_label,
          pattern_count: bundle.pattern_count,
          bundle_count: bundle.bundle_count,
          pieces_total: bundle.pieces_in_bundle,
          user_id: user.id,
          user_username: user.username,
          user_role: user.roleName,
          master_id: masterDetails.masterId,
          master_name: masterDetails.masterName,
          remark,
        }]);

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
            masterId: masterDetails.masterId,
            masterName: masterDetails.masterName,
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
                  lot_id AS lotId, bundle_id AS bundleId, size_id AS sizeId, piece_id AS pieceId,
                  lot_number AS lotNumber, bundle_code AS bundleCode, size_label AS sizeLabel, piece_code AS pieceCode,
                  pattern_count AS patternCount, bundle_count AS bundleCount, pieces_total AS piecesTotal,
                  user_id AS userId, user_username AS userUsername, user_role AS userRole,
                  master_id AS masterId, master_name AS masterName,
                  remark, event_status AS eventStatus, is_closed AS isClosed,
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
                  lot_id AS lotId, bundle_id AS bundleId, size_id AS sizeId, piece_id AS pieceId,
                  lot_number AS lotNumber, bundle_code AS bundleCode, size_label AS sizeLabel, piece_code AS pieceCode,
                  pattern_count AS patternCount, bundle_count AS bundleCount, pieces_total AS piecesTotal,
                  user_id AS userId, user_username AS userUsername, user_role AS userRole,
                  master_id AS masterId, master_name AS masterName,
                  remark, event_status AS eventStatus, is_closed AS isClosed,
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
