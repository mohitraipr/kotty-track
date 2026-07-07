-- Generic production audit trail for operator lot interventions:
--   flow_change   — denim/hosiery flow_type changed
--   stage_reversal — a lot pushed back to its previous stage (events/payments undone)
--   qty_edit      — per-size quantities edited at a stage
-- `detail` holds an action-specific before/after snapshot (JSON) so a developer can fully
-- reconstruct what happened. Append-only; never updated.
CREATE TABLE IF NOT EXISTS pm_lot_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NULL,
  lot_no VARCHAR(50) NULL,
  action VARCHAR(40) NOT NULL,
  detail JSON NULL,
  performed_by INT NULL,
  performed_by_name VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_action (action),
  INDEX idx_created (created_at)
);
