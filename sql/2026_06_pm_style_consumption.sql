-- CAD per-size fabric consumption per style.
--
-- Owner ruling (2026-06-18): CAD is the fabric truth. fabric = sum(size_qty * consumption).
-- CAD generates the marker; our system only produces quantities + lots and uses these
-- numbers to compute the fabric to issue. Populated by upload (utils/cadConsumption.js)
-- for the few styles that have CAD data today; grows over time.
--
-- One row per (style, size_label). size_label is the ecom letter size (S/M/L/XL/XXL/...),
-- extracted from combined CAD labels like "S / 26".
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS pm_style_consumption (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  style                 VARCHAR(100) NOT NULL,
  size_label            VARCHAR(20)  NOT NULL,
  fabric_type           VARCHAR(100) NULL,
  consumption_per_piece DECIMAL(7,3) NOT NULL,           -- meters (or kg) of fabric per piece
  consumption_unit      ENUM('METER','KG') NOT NULL DEFAULT 'METER',
  source                ENUM('cad','manual') NOT NULL DEFAULT 'cad',
  loaded_by             INT NULL,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_style_size (style, size_label),
  INDEX idx_style (style)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
