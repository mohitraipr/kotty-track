-- ─────────────────────────────────────────────────────────────────
-- stage_payments: relax UNIQUE KEY for multi-batch event-model
--
-- The original schema enforced one payment per (lot_no, stage, user)
-- which prevented partial / multi-batch payments. The new event model
-- fires one payment per APPROVE event (one batch at a time), so we
-- need to allow multiple rows for the same lot+stage+user.
--
-- Safe: idempotent. Only runs the DROP if the index exists.
-- ─────────────────────────────────────────────────────────────────

SET @drop := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'stage_payments'
     AND index_name = 'uk_lot_stage_user') > 0,
  'ALTER TABLE stage_payments DROP INDEX uk_lot_stage_user',
  'SELECT "uk_lot_stage_user already absent"'
);
PREPARE stmt FROM @drop;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add a non-unique composite index for fast lookups by (lot, stage, user).
-- The unique guarantee is now enforced at the application layer (one
-- payment per APPROVE event).
SET @idx := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'stage_payments'
     AND index_name = 'idx_lot_stage_user') = 0,
  'ALTER TABLE stage_payments ADD INDEX idx_lot_stage_user (lot_no, stage, user_id)',
  'SELECT "idx_lot_stage_user already exists"'
);
PREPARE stmt FROM @idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
