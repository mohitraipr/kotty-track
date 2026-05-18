-- Return Challan Dashboard schema.
--
-- Idempotent. Safe to re-run.
--
-- Pattern: counter table + main entries table + custom-fields registry.
-- Custom field values live in return_challans.custom_data JSON keyed by
-- the same field_key in return_challan_field_defs.

-- ─── 1) Counter (fiscal-year-scoped sequence) ────────────────────────
CREATE TABLE IF NOT EXISTS return_challan_counters (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  year_range      VARCHAR(7) NOT NULL,          -- '2026-27'
  current_counter INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_year (year_range)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2) One row per challan entry ───────────────────────────────────
CREATE TABLE IF NOT EXISTS return_challans (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_no      VARCHAR(32) NOT NULL UNIQUE,  -- 'RC/2026-27/00001'
  description     TEXT NULL,
  qty             DECIMAL(12,2) NOT NULL DEFAULT 0,
  category        VARCHAR(120) NULL,
  brand_name      VARCHAR(120) NULL,
  is_branded      TINYINT(1) NOT NULL DEFAULT 0,
  price           DECIMAL(12,2) NOT NULL DEFAULT 0,
  image_s3_key    VARCHAR(500) NULL,            -- S3 key, presigned on read
  name            VARCHAR(180) NULL,
  challan_date    DATE NULL,
  punching_no     VARCHAR(80) NULL,
  department      VARCHAR(120) NULL,
  custom_data     JSON NULL,                    -- {fieldKey: value}
  created_by      INT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rc_created (created_at DESC),
  KEY idx_rc_date (challan_date),
  KEY idx_rc_dept (department),
  CONSTRAINT fk_rc_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3) Shared custom field definitions ──────────────────────────────
CREATE TABLE IF NOT EXISTS return_challan_field_defs (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  field_key       VARCHAR(60) NOT NULL UNIQUE,  -- snake_case
  label           VARCHAR(120) NOT NULL,
  field_type      ENUM('text','number','date','boolean','select') NOT NULL DEFAULT 'text',
  options_json    JSON NULL,                    -- for type=select
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 100,
  created_by      INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 4) Register the role ────────────────────────────────────────────
INSERT IGNORE INTO roles (name) VALUES ('returnchallan');

-- ─── 5) v2: multi-image (max 15 per challan) ─────────────────────────
-- Each challan can have up to 15 photos. The legacy
-- return_challans.image_s3_key column above stays for back-compat reads
-- of pre-v2 rows; new entries write only to this child table.
CREATE TABLE IF NOT EXISTS return_challan_images (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_id   INT NOT NULL,
  s3_key       VARCHAR(500) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 100,   -- preserves upload order
  uploaded_by  INT NULL,
  uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rci_challan (challan_id, sort_order),
  CONSTRAINT fk_rci_challan FOREIGN KEY (challan_id) REFERENCES return_challans(id) ON DELETE CASCADE,
  CONSTRAINT fk_rci_user    FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
