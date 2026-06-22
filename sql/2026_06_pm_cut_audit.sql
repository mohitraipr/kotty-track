-- Feature C — PM cut audit (decision snapshot + dispatch→reflection ledger)
CREATE TABLE IF NOT EXISTS pm_cut_decision_snapshot (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  assignment_id   INT NULL,
  style           VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,
  assigned_qty    INT NOT NULL,
  drr             DECIMAL(10,4) NULL,
  suggested_cut_qty INT NULL,
  soh             INT NULL,
  doh             DECIMAL(10,2) NULL,
  decided_by      INT NULL,
  decided_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_style_size (style, size_label),
  INDEX idx_decided_at (decided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_dispatch_reflection (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lot_no          VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,
  style           VARCHAR(100) NULL,
  dispatched_qty  INT NOT NULL,
  first_dispatch_date DATE NULL,
  last_dispatch_date  DATE NULL,
  batch_count     INT NOT NULL DEFAULT 0,
  soh_before      INT NULL,
  reflected_qty   INT NULL,
  reflected_date  DATE NULL,
  lag_days        INT NULL,
  gap_qty         INT NULL,
  status          ENUM('pending','reflected','partial','not_reflected') NOT NULL DEFAULT 'pending',
  reconciled_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_lot_size (lot_no, size_label),
  INDEX idx_status (status),
  INDEX idx_size_sku (size_sku),
  INDEX idx_last_dispatch (last_dispatch_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
