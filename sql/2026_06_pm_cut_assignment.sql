-- PM-approved cut assignments routed to a specific cutting master.
--
-- Flow: the PM views a style's suggested cut (utils/cutPlanner.planCut), picks a cutting
-- master, and approves. That creates one pm_cut_assignment (header) + pm_cut_assignment_sizes
-- (what to cut, per size). The chosen master sees it in their "Assigned Cuts" list and cuts
-- to those quantities (CAD makes the marker). When the master creates the cutting lot from
-- it, cutting_lot_id links back and status moves to 'cut'.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS pm_cut_assignment (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  style                VARCHAR(100) NOT NULL,
  fabric_type          VARCHAR(100) NULL,
  total_pieces         INT NOT NULL,
  lot_count            INT NOT NULL DEFAULT 0,        -- suggested number of lots (<=1500 each)
  total_fabric_meters  DECIMAL(12,2) NULL,            -- from CAD; NULL if CAD data incomplete
  fabric_complete      TINYINT(1) NOT NULL DEFAULT 0,
  assigned_master_id   INT NOT NULL,                  -- users.id of the cutting master
  assigned_master_name VARCHAR(100) NULL,
  status               ENUM('assigned','cut','cancelled') NOT NULL DEFAULT 'assigned',
  created_by           INT NULL,                      -- users.id of the PM who approved
  cutting_lot_id       INT NULL,                      -- set when the master cuts it
  note                 VARCHAR(255) NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_master_status (assigned_master_id, status),
  INDEX idx_style (style),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_cut_assignment_sizes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  assignment_id INT NOT NULL,
  size_label    VARCHAR(20) NOT NULL,
  qty           INT NOT NULL,
  INDEX idx_assignment (assignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
