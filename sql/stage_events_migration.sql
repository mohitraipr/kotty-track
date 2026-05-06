-- ─────────────────────────────────────────────────────────────────────
-- Stage Events Migration
--
-- Replaces the single "submit creates assignment + data" model with
-- an event log per stage. Each lot at each stage accumulates many
-- events (approve, complete, reject) with full size breakdowns.
--
-- Aggregate per (lot, stage):
--   approved   = SUM(pieces) WHERE event_type='approve'
--   completed  = SUM(pieces) WHERE event_type='complete'
--   rejected   = SUM(pieces) WHERE event_type='reject'
--   inline     = approved - completed - rejected
--
-- Cross-stage availability:
--   what stage X+1 may approve from stage X
--     = (stage_X completed total) - (stage_X+1 approved total)
--
-- Existing assignment + data tables are left intact. New flow uses
-- these event tables exclusively. In-flight lots that were started
-- under the old model finish under the old model.
-- ─────────────────────────────────────────────────────────────────────

-- ─── Stitching ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stitching_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NOT NULL,
  event_type ENUM('approve', 'complete', 'reject') NOT NULL,
  parent_event_id INT NULL,
  pieces INT NOT NULL,
  operator_id INT NOT NULL,
  remark TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot_type (cutting_lot_id, event_type),
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_parent (parent_event_id),
  INDEX idx_operator (operator_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (cutting_lot_id) REFERENCES cutting_lots(id),
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_event_id) REFERENCES stitching_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS stitching_event_sizes (
  event_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL,
  PRIMARY KEY (event_id, size_label),
  FOREIGN KEY (event_id) REFERENCES stitching_events(id) ON DELETE CASCADE
);

-- ─── Jeans Assembly ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jeans_assembly_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NOT NULL,
  event_type ENUM('approve', 'complete', 'reject') NOT NULL,
  parent_event_id INT NULL,
  pieces INT NOT NULL,
  operator_id INT NOT NULL,
  remark TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot_type (cutting_lot_id, event_type),
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_parent (parent_event_id),
  INDEX idx_operator (operator_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (cutting_lot_id) REFERENCES cutting_lots(id),
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_event_id) REFERENCES jeans_assembly_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS jeans_assembly_event_sizes (
  event_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL,
  PRIMARY KEY (event_id, size_label),
  FOREIGN KEY (event_id) REFERENCES jeans_assembly_events(id) ON DELETE CASCADE
);

-- ─── Washing ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS washing_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NOT NULL,
  event_type ENUM('approve', 'complete', 'reject') NOT NULL,
  parent_event_id INT NULL,
  pieces INT NOT NULL,
  operator_id INT NOT NULL,
  remark TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot_type (cutting_lot_id, event_type),
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_parent (parent_event_id),
  INDEX idx_operator (operator_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (cutting_lot_id) REFERENCES cutting_lots(id),
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_event_id) REFERENCES washing_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS washing_event_sizes (
  event_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL,
  PRIMARY KEY (event_id, size_label),
  FOREIGN KEY (event_id) REFERENCES washing_events(id) ON DELETE CASCADE
);

-- ─── Washing In ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS washing_in_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NOT NULL,
  event_type ENUM('approve', 'complete', 'reject') NOT NULL,
  parent_event_id INT NULL,
  pieces INT NOT NULL,
  operator_id INT NOT NULL,
  remark TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot_type (cutting_lot_id, event_type),
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_parent (parent_event_id),
  INDEX idx_operator (operator_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (cutting_lot_id) REFERENCES cutting_lots(id),
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_event_id) REFERENCES washing_in_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS washing_in_event_sizes (
  event_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL,
  PRIMARY KEY (event_id, size_label),
  FOREIGN KEY (event_id) REFERENCES washing_in_events(id) ON DELETE CASCADE
);

-- ─── Finishing ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finishing_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cutting_lot_id INT NOT NULL,
  event_type ENUM('approve', 'complete', 'reject') NOT NULL,
  parent_event_id INT NULL,
  pieces INT NOT NULL,
  operator_id INT NOT NULL,
  remark TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lot_type (cutting_lot_id, event_type),
  INDEX idx_lot (cutting_lot_id),
  INDEX idx_parent (parent_event_id),
  INDEX idx_operator (operator_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (cutting_lot_id) REFERENCES cutting_lots(id),
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_event_id) REFERENCES finishing_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS finishing_event_sizes (
  event_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL,
  PRIMARY KEY (event_id, size_label),
  FOREIGN KEY (event_id) REFERENCES finishing_events(id) ON DELETE CASCADE
);
