-- ─────────────────────────────────────────────────────────────────────
-- Stage Approval Corrections — audit log for operator-driven fixes of a
-- wrong-operator approval (e.g. lot UM416 was approved by Salim but should
-- have been Salman). A floor supervisor (role `operator`) reattributes the
-- lot at a stage; every move is recorded here, including already-PAID
-- payment rows, so accountants can see exactly what changed.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stage_approval_corrections (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  stage               VARCHAR(20)  NOT NULL,   -- stitching|assembly|washing|washing_in|finishing
  cutting_lot_id      INT          NOT NULL,
  lot_no              VARCHAR(50)  NOT NULL,
  from_user_id        INT          NOT NULL,   -- operator the lot was wrongly attributed to
  to_user_id          INT          NOT NULL,   -- operator it should belong to
  corrected_by        INT          NOT NULL,   -- supervisor (operator role) who made the fix
  events_moved        INT NOT NULL DEFAULT 0,  -- *_events rows reattributed
  data_rows_moved     INT NOT NULL DEFAULT 0,  -- legacy *_data rows reattributed
  payments_moved      INT NOT NULL DEFAULT 0,  -- stage_payments rows reattributed (all)
  paid_payments_moved INT NOT NULL DEFAULT 0,  -- subset of the above already marked 'paid'
  created_at          DATETIME     NOT NULL,
  INDEX idx_lot (lot_no),
  INDEX idx_stage (stage),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
