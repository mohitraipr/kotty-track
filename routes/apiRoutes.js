const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const generateApiLotNumber = require('../utils/generateApiLotNumber');

// Simple in-memory cache for rolls to avoid repeated DB reads
let rollsCache = { data: null, expires: 0 };

// Function to fetch rolls by fabric type from existing tables
async function getRollsByFabricType() {
  if (rollsCache.data && Date.now() < rollsCache.expires) {
    return rollsCache.data;
  }
  try {
    const [rows] = await pool.query(`
      SELECT fi.fabric_type, fir.roll_no, fir.per_roll_weight, fir.unit, v.name AS vendor_name
      FROM fabric_invoice_rolls fir
      JOIN fabric_invoices fi ON fir.invoice_id = fi.id
      JOIN vendors v ON fir.vendor_id = v.id
      WHERE fir.per_roll_weight > 0 AND fi.fabric_type IS NOT NULL
    `);

    const rollsByFabricType = {};
    rows.forEach((row) => {
      if (!rollsByFabricType[row.fabric_type]) {
        rollsByFabricType[row.fabric_type] = [];
      }
      rollsByFabricType[row.fabric_type].push({
        roll_no: row.roll_no,
        unit: row.unit,
        per_roll_weight: row.per_roll_weight,
        vendor_name: row.vendor_name,
      });
    });

    rollsCache = { data: rollsByFabricType, expires: Date.now() + 5 * 60 * 1000 };
    return rollsByFabricType;
  } catch (err) {
    console.error('Error fetching rolls by fabric type:', err);
    return {};
  }
}

// GET /api/fabric-rolls - Fetch fabric types and their rolls
router.get(
  '/fabric-rolls',
  isAuthenticated,
  allowRoles(['cutting_manager', 'cutting_master']),
  async (req, res) => {
    try {
      const rollsByFabricType = await getRollsByFabricType();
      res.json(rollsByFabricType);
    } catch (err) {
      console.error('Error in /api/fabric-rolls:', err);
      res.status(500).json({ error: 'Failed to fetch fabric rolls' });
    }
  }
);

function createClientError(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  error.clientMessage = message;
  return error;
}

function normaliseSizeEntry(entry, bundleSize) {
  if (!entry || typeof entry !== 'object') {
    throw createClientError('Each size entry must be an object.');
  }

  const rawLabel = entry.sizeLabel || entry.size || entry.label;
  const sizeLabel = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!sizeLabel) {
    throw createClientError('Size label is required for every size entry.');
  }

  const patternSource =
    entry.patternCount ?? entry.pattern_count ?? entry.pattern ?? entry.patterns;
  let patternCount = Number(patternSource);
  if (!Number.isFinite(patternCount) || patternCount <= 0) {
    patternCount = Number(entry.totalPieces ?? entry.total_pieces);
  }
  if (!Number.isFinite(patternCount) || patternCount <= 0) {
    throw createClientError(
      `Pattern count is required for size ${sizeLabel} and must be greater than zero.`,
    );
  }

  const totalSource = entry.totalPieces ?? entry.total_pieces;
  let totalPieces = Number(totalSource);
  if (!Number.isFinite(totalPieces) || totalPieces <= 0) {
    const layersSource = entry.layers ?? entry.totalLayers ?? entry.layer_count;
    const layers = Number(layersSource);
    if (Number.isFinite(layers) && layers > 0) {
      totalPieces = patternCount * layers;
    }
  }

  if (!Number.isFinite(totalPieces) || totalPieces <= 0) {
    throw createClientError(
      `Total pieces must be provided for size ${sizeLabel} and must be greater than zero.`,
    );
  }

  const roundedTotal = Math.round(totalPieces);
  if (Math.abs(roundedTotal - totalPieces) > 0.0001) {
    throw createClientError(`Total pieces for size ${sizeLabel} must be a whole number.`);
  }

  const roundedPattern = Math.round(patternCount);
  if (Math.abs(roundedPattern - patternCount) > 0.0001) {
    throw createClientError(`Pattern count for size ${sizeLabel} must be a whole number.`);
  }

  const bundleCount = Math.max(1, Math.ceil(roundedTotal / bundleSize));

  return {
    sizeLabel,
    patternCount: roundedPattern,
    totalPieces: roundedTotal,
    bundleCount,
  };
}

function normaliseRollEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw createClientError('Each roll entry must be an object.');
  }

  const rawRollNo = entry.rollNo || entry.roll_no || entry.rollNumber;
  const rollNo = typeof rawRollNo === 'string' ? rawRollNo.trim() : '';
  if (!rollNo) {
    throw createClientError('Roll number is required for every roll entry.');
  }

  const weightSource = entry.weightUsed ?? entry.weight_used ?? entry.weight;
  const weightUsed = Number(weightSource);
  if (!Number.isFinite(weightUsed) || weightUsed <= 0) {
    throw createClientError(
      `Weight used must be provided for roll ${rollNo} and must be greater than zero.`,
    );
  }

  return { rollNo, weightUsed };
}

router.post(
  '/lots',
  isAuthenticated,
  allowRoles(['cutting_master']),
  async (req, res) => {
    const user = req.session?.user;
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      sku,
      fabricType,
      remark = null,
      bundleSize,
      sizes: rawSizes,
      rolls: rawRolls,
    } = req.body || {};

    if (!sku || typeof sku !== 'string' || !sku.trim()) {
      return res.status(400).json({ error: 'SKU is required.' });
    }

    if (!fabricType || typeof fabricType !== 'string' || !fabricType.trim()) {
      return res.status(400).json({ error: 'fabricType is required.' });
    }

    const numericBundleSize = Number(bundleSize);
    if (!Number.isInteger(numericBundleSize) || numericBundleSize <= 0) {
      return res
        .status(400)
        .json({ error: 'bundleSize must be a positive whole number.' });
    }

    if (!Array.isArray(rawSizes) || rawSizes.length === 0) {
      return res.status(400).json({ error: 'At least one size entry is required.' });
    }

    let normalisedSizes;
    try {
      normalisedSizes = rawSizes.map((entry) => normaliseSizeEntry(entry, numericBundleSize));
    } catch (validationError) {
      return res
        .status(validationError.statusCode || 400)
        .json({ error: validationError.clientMessage || validationError.message });
    }

    if (!Array.isArray(rawRolls) || rawRolls.length === 0) {
      return res.status(400).json({ error: 'At least one roll entry is required.' });
    }

    let normalisedRolls;
    try {
      normalisedRolls = rawRolls.map((entry) => normaliseRollEntry(entry));
    } catch (validationError) {
      return res
        .status(validationError.statusCode || 400)
        .json({ error: validationError.clientMessage || validationError.message });
    }

    const totalPieces = normalisedSizes.reduce((sum, size) => sum + size.totalPieces, 0);
    const totalBundles = normalisedSizes.reduce((sum, size) => sum + size.bundleCount, 0);
    const totalWeight = normalisedRolls.reduce((sum, roll) => sum + roll.weightUsed, 0);

    let conn;
    let transactionStarted = false;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      transactionStarted = true;

      const [[fabricTypeExists]] = await conn.query(
        'SELECT 1 FROM fabric_invoices WHERE fabric_type = ? LIMIT 1',
        [fabricType.trim()],
      );

      if (!fabricTypeExists) {
        throw createClientError('Provided fabricType does not exist in fabric records.');
      }

      const lotNumber = await generateApiLotNumber(user.username, user.id, conn);

      const [lotResult] = await conn.query(
        `
          INSERT INTO api_lots
            (lot_number, cutting_master_id, sku, fabric_type, remark, bundle_size, total_bundles, total_pieces, total_weight)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          lotNumber,
          user.id,
          sku.trim(),
          fabricType.trim(),
          remark && typeof remark === 'string' ? remark.trim() : null,
          numericBundleSize,
          totalBundles,
          totalPieces,
          totalWeight,
        ],
      );

      const lotId = lotResult.insertId;

      for (const roll of normalisedRolls) {
        const [[rollRecord]] = await conn.query(
          `SELECT id, per_roll_weight FROM fabric_invoice_rolls WHERE roll_no = ? FOR UPDATE`,
          [roll.rollNo],
        );

        if (!rollRecord) {
          throw createClientError(`Roll number ${roll.rollNo} was not found in inventory.`);
        }

        if (Number(rollRecord.per_roll_weight) < roll.weightUsed) {
          throw createClientError(
            `Insufficient available weight on roll ${roll.rollNo}. Requested ${roll.weightUsed}.`,
          );
        }

        await conn.query(
          `UPDATE fabric_invoice_rolls SET per_roll_weight = per_roll_weight - ? WHERE id = ?`,
          [roll.weightUsed, rollRecord.id],
        );

        await conn.query(
          `INSERT INTO api_lot_rolls (lot_id, fabric_roll_id, roll_no, weight_used) VALUES (?, ?, ?, ?)`,
          [lotId, rollRecord.id, roll.rollNo, roll.weightUsed],
        );
      }

      const bundleOutputs = [];
      const pieceOutputs = [];
      const pieceRows = [];
      let bundleSequence = 1;
      let pieceSequence = 1;

      for (const sizeEntry of normalisedSizes) {
        const [sizeResult] = await conn.query(
          `
            INSERT INTO api_lot_sizes (lot_id, size_label, pattern_count, total_pieces, bundle_count)
            VALUES (?, ?, ?, ?, ?)
          `,
          [
            lotId,
            sizeEntry.sizeLabel,
            sizeEntry.patternCount,
            sizeEntry.totalPieces,
            sizeEntry.bundleCount,
          ],
        );

        const sizeId = sizeResult.insertId;
        let remainingPieces = sizeEntry.totalPieces;
        let sizeBundleIndex = 1;

        while (remainingPieces > 0) {
          if (bundleSequence > 999999) {
            throw createClientError(
              'Bundle code limit exceeded. Please reduce bundle size or split the lot.',
            );
          }

          const piecesInBundle = Math.min(numericBundleSize, remainingPieces);
          const bundleCode = String(bundleSequence).padStart(6, '0');

          const [bundleResult] = await conn.query(
            `
              INSERT INTO api_lot_bundles
                (lot_id, size_id, bundle_sequence, size_bundle_index, bundle_code, pieces_in_bundle)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
              lotId,
              sizeId,
              bundleSequence,
              sizeBundleIndex,
              bundleCode,
              piecesInBundle,
            ],
          );

          const bundleId = bundleResult.insertId;

          bundleOutputs.push({
            bundleCode,
            sizeLabel: sizeEntry.sizeLabel,
            pieces: piecesInBundle,
          });

          for (let index = 1; index <= piecesInBundle; index += 1) {
            if (pieceSequence > 99999999) {
              throw createClientError(
                'Piece code limit exceeded. Please reduce total pieces for this lot.',
              );
            }
            const pieceCode = String(pieceSequence).padStart(8, '0');
            pieceRows.push([lotId, bundleId, sizeId, pieceSequence, index, pieceCode]);
            pieceOutputs.push({
              pieceCode,
              bundleCode,
              sizeLabel: sizeEntry.sizeLabel,
            });
            pieceSequence += 1;
          }

          remainingPieces -= piecesInBundle;
          bundleSequence += 1;
          sizeBundleIndex += 1;
        }
      }

      if (pieceRows.length) {
        const chunkSize = 500;
        for (let i = 0; i < pieceRows.length; i += chunkSize) {
          const chunk = pieceRows.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
          const flatValues = chunk.flat();
          await conn.query(
            `
              INSERT INTO api_lot_piece_codes
                (lot_id, bundle_id, size_id, piece_sequence, bundle_piece_index, piece_code)
              VALUES ${placeholders}
            `,
            flatValues,
          );
        }
      }

      await conn.commit();

      return res.status(201).json({
        message: 'Lot created successfully.',
        lot: {
          id: lotId,
          lotNumber,
          sku: sku.trim(),
          fabricType: fabricType.trim(),
          remark: remark && typeof remark === 'string' ? remark.trim() : null,
          bundleSize: numericBundleSize,
          totalBundles,
          totalPieces,
          totalWeight,
          sizes: normalisedSizes,
          bundles: bundleOutputs,
          pieces: pieceOutputs,
        },
      });
    } catch (error) {
      if (conn && transactionStarted) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('Failed to rollback transaction:', rollbackError);
        }
      }

      console.error('Error creating API lot:', error);
      const status = error.statusCode || 500;
      return res.status(status).json({
        error: error.clientMessage || 'Failed to create lot.',
      });
    } finally {
      if (conn) {
        conn.release();
      }
    }
  },
);

module.exports = router;
