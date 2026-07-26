-- High-ageing cutting block (design: docs/superpowers/specs/2026-07-26-high-ageing-cutting-block-design.md).
-- Stores only HUMAN decisions: a manual block, or an allow-exception for an
-- auto-flagged style. The auto-flagged set itself is computed live from cut-recs,
-- never persisted here (so it can't go stale). One row per style.
CREATE TABLE IF NOT EXISTS pm_cutting_blocklist (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  style           VARCHAR(100) NOT NULL,
  mode            ENUM('manual_block','allow') NOT NULL,
  reason          VARCHAR(255) NULL,
  created_by      INT NULL,
  created_by_name VARCHAR(100) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_style (style)
);

-- Global enforcement toggle lives in store_settings (default ON). Seed it once.
INSERT IGNORE INTO store_settings (setting_key, setting_value)
VALUES ('high_ageing_block_enabled', 'true');
