-- sql/production_flow_tables.sql
-- Schema to capture staged production flow events across stitching, washing, and finishing.

CREATE TABLE IF NOT EXISTS production_flow_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stage ENUM('back_pocket','stitching_master','jeans_assembly','washing','washing_in','finishing') NOT NULL,
  code_type ENUM('bundle','lot','piece') NOT NULL,
  code_value VARCHAR(64) NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  bundle_id BIGINT UNSIGNED DEFAULT NULL,
  piece_id BIGINT UNSIGNED DEFAULT NULL,
  lot_number VARCHAR(32) NOT NULL,
  bundle_code VARCHAR(64) DEFAULT NULL,
  piece_code VARCHAR(64) DEFAULT NULL,
  pieces_total INT UNSIGNED DEFAULT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  user_username VARCHAR(100) NOT NULL,
  user_role VARCHAR(64) NOT NULL,
  master_id BIGINT UNSIGNED DEFAULT NULL,
  master_name VARCHAR(255) DEFAULT NULL,
  remark VARCHAR(255) DEFAULT NULL,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  closed_by_stage ENUM('back_pocket','stitching_master','jeans_assembly','washing','washing_in','finishing') DEFAULT NULL,
  closed_by_user_id BIGINT UNSIGNED DEFAULT NULL,
  closed_by_user_username VARCHAR(100) DEFAULT NULL,
  closed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_production_flow_stage_code (stage, code_value),
  KEY idx_production_flow_lot_stage (lot_id, stage),
  KEY idx_production_flow_bundle_stage (bundle_id, stage),
  KEY idx_production_flow_piece_stage (piece_id, stage),
  CONSTRAINT fk_production_flow_lot FOREIGN KEY (lot_id) REFERENCES api_lots(id),
  CONSTRAINT fk_production_flow_bundle FOREIGN KEY (bundle_id) REFERENCES api_lot_bundles(id),
  CONSTRAINT fk_production_flow_piece FOREIGN KEY (piece_id) REFERENCES api_lot_piece_codes(id),
  CONSTRAINT fk_production_flow_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_production_flow_master FOREIGN KEY (master_id) REFERENCES user_masters(id) ON DELETE SET NULL,
  CONSTRAINT fk_production_flow_closed_user FOREIGN KEY (closed_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migration snippet to add master tracking to an existing installation:
-- ALTER TABLE production_flow_events
--   ADD COLUMN master_id BIGINT UNSIGNED DEFAULT NULL AFTER user_role,
--   ADD COLUMN master_name VARCHAR(255) DEFAULT NULL AFTER master_id,
--   ADD CONSTRAINT fk_production_flow_master FOREIGN KEY (master_id) REFERENCES user_masters(id) ON DELETE SET NULL;

