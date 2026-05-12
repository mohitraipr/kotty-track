-- Lot-aware indent system: structured item taxonomy + lot↔indent traceability.
-- Idempotent; safe to re-run. Also auto-applied at runtime by indentRoutes.ensureMigration().

-- 1) Item taxonomy ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_categories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  display_label VARCHAR(80) NOT NULL,
  unit_default VARCHAR(20) NOT NULL DEFAULT 'PCS',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO item_categories (name, display_label, unit_default) VALUES
  ('zipper',  'Zipper',  'PCS'),
  ('button',  'Button',  'PCS'),
  ('dhaga',   'Dhaga (Thread)', 'CONE'),
  ('elastic', 'Elastic', 'MTR'),
  ('other',   'Other',   'PCS');

-- 2) Extend goods_inventory with structured category + variant ---------------
-- variant_number examples: "25" / "50" for dhaga,  "#16" / "#20" for buttons,
-- "8 inch" / "10 inch" for zippers, "Denim" / "Hosiery" hint for elastic.
-- Added only if columns don't already exist (handled in app code).

-- 3) Lot type on cutting_lots -----------------------------------------------
-- Added in app code (ALTER guarded by SHOW COLUMNS).
-- Backfilled from fabric_type by app code.

-- 4) Lot ↔ material consumption audit ---------------------------------------
CREATE TABLE IF NOT EXISTS lot_material_consumption (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  indent_request_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(50) NOT NULL,
  filler_stage VARCHAR(50) DEFAULT NULL,
  category_id INT UNSIGNED DEFAULT NULL,
  variant_number VARCHAR(50) DEFAULT NULL,
  goods_id BIGINT UNSIGNED DEFAULT NULL,
  planned_qty DECIMAL(12,2) NOT NULL,
  final_qty DECIMAL(12,2) DEFAULT NULL,
  status ENUM('open','proceeding','arrived','cancelled') DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finalized_at DATETIME DEFAULT NULL,
  INDEX idx_lmc_lot (lot_no),
  INDEX idx_lmc_indent (indent_request_id),
  INDEX idx_lmc_cat (category_id, lot_no),
  CONSTRAINT fk_lmc_indent FOREIGN KEY (indent_request_id) REFERENCES indent_requests(id) ON DELETE CASCADE
);
