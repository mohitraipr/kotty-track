-- pm_sku_resolution: the human-authored cutting-style -> ecom size-SKU map (the
-- "chart"). Frozen, validated rows the auto-binder trusts. Per (cl_sku, size_label).
--   state='resolved' : size_sku set and verified to exist in ee_suborders.
--   state='excluded' : a SKIP decision (discontinued/liquidating) — NOT a gap;
--                      the binder marks these lot-sizes bind_state='excluded'.
-- Additive, pm_-side only. No production/flow table is touched.

CREATE TABLE IF NOT EXISTS pm_sku_resolution (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cl_sku      VARCHAR(100) NOT NULL,                    -- cutting style code (cutting_lots.sku)
  size_label  VARCHAR(40)  NOT NULL,                    -- cutting size (cutting_lot_sizes.size_label)
  size_sku    VARCHAR(100) NULL,                        -- resolved ecom size-SKU; NULL when excluded
  state       ENUM('resolved','excluded') NOT NULL,
  source      ENUM('size_sheet','style_sheet','manual') NOT NULL DEFAULT 'size_sheet',
  ruling      ENUM('waist','letter','skip') NULL,       -- style-level ruling that produced the row, if any
  loaded_by   INT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_pair (cl_sku, size_label),            -- one mapping per cut lot-size
  INDEX idx_size_sku (size_sku),
  INDEX idx_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
