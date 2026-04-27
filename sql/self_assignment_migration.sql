-- Self-Assignment Migration
-- Run this to enable the new self-assignment workflow
-- Created: 2026-04-21

-- ============================================
-- STEP 1: Add is_denim_cutter column to users
-- ============================================
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_denim_cutter TINYINT(1) DEFAULT NULL
COMMENT 'NULL=not cutting manager, 1=denim cutter, 0=hosiery cutter';

-- ============================================
-- STEP 2: Tag denim cutters
-- ============================================
-- Set all cutting managers to hosiery (0) by default
UPDATE users
SET is_denim_cutter = 0
WHERE role_id IN (SELECT id FROM roles WHERE name = 'cutting_manager');

-- Tag specific users as denim cutters
UPDATE users SET is_denim_cutter = 1 WHERE id IN (3, 52);
-- akshay (id: 3) and umairSambhal (id: 52)

-- ============================================
-- STEP 3: Add sizes_json to stitching_assignments
-- ============================================
ALTER TABLE stitching_assignments
ADD COLUMN IF NOT EXISTS sizes_json JSON DEFAULT NULL
COMMENT 'Sizes claimed: [{"size":"S","qty":250},...]';

-- ============================================
-- STEP 4: Create view for available sizes per lot
-- ============================================
DROP VIEW IF EXISTS v_lot_available_sizes;

CREATE VIEW v_lot_available_sizes AS
SELECT
  cl.lot_no,
  cl.id AS cutting_lot_id,
  cl.user_id AS cutting_master_id,
  cls.size_label,
  cls.total_pieces AS cut_qty,
  COALESCE(claimed.claimed_qty, 0) AS claimed_qty,
  cls.total_pieces - COALESCE(claimed.claimed_qty, 0) AS available_qty
FROM cutting_lots cl
JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
LEFT JOIN (
  -- Aggregate from stitching_data_sizes (actual completed work)
  SELECT
    sd.lot_no,
    sds.size_label,
    SUM(sds.pieces) AS claimed_qty
  FROM stitching_data sd
  JOIN stitching_data_sizes sds ON sds.stitching_data_id = sd.id
  GROUP BY sd.lot_no, sds.size_label
) claimed ON claimed.lot_no = cl.lot_no AND claimed.size_label = cls.size_label;

-- ============================================
-- STEP 5: Backfill sizes_json for existing assignments
-- ============================================
-- This updates existing approved assignments with their actual completed sizes
UPDATE stitching_assignments sa
JOIN cutting_lots cl ON cl.id = sa.cutting_lot_id
SET sa.sizes_json = (
  SELECT JSON_ARRAYAGG(JSON_OBJECT('size', sds.size_label, 'qty', sds.pieces))
  FROM stitching_data sd
  JOIN stitching_data_sizes sds ON sds.stitching_data_id = sd.id
  WHERE sd.lot_no = cl.lot_no AND sd.user_id = sa.user_id
)
WHERE sa.isApproved = 1 AND sa.sizes_json IS NULL;

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Run these to verify the migration worked:

-- Check denim cutters:
-- SELECT id, username, is_denim_cutter FROM users WHERE is_denim_cutter IS NOT NULL;

-- Check sizes_json backfill:
-- SELECT id, cutting_lot_id, user_id, sizes_json FROM stitching_assignments WHERE sizes_json IS NOT NULL LIMIT 10;

-- Check available sizes view:
-- SELECT * FROM v_lot_available_sizes WHERE available_qty > 0 LIMIT 10;
