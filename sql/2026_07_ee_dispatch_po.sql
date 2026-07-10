-- Finishing dispatch → EasyEcom PO pipeline (docs/EASYECOM_DISPATCH_GRN_DESIGN.md)
-- Model: kotty-track creates ONLY the PO (the challan). The warehouse GRNs it manually
-- in the EasyEcom UI; a confirmation poller matches getGrnDetails.po_id back to batches.

-- Batch ledger: one row per PO we create (idempotency spine).
CREATE TABLE IF NOT EXISTS ee_dispatch_po (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  batch_ref     VARCHAR(40) NOT NULL UNIQUE,   -- 'KT-DISP-<id>' → PO referenceCode/docNumber
  status        ENUM('draft','blocked','pushed','confirmed','failed','cancelled') NOT NULL DEFAULT 'draft',
  warehouse_id  INT NOT NULL DEFAULT 173983,   -- Faridabad
  po_id         BIGINT NULL,                   -- EasyEcom poId after push
  grn_id        BIGINT NULL,                   -- warehouse's GRN once detected
  grn_status    VARCHAR(40) NULL,
  total_qty     INT NOT NULL DEFAULT 0,
  line_count    INT NOT NULL DEFAULT 0,
  blocked_count INT NOT NULL DEFAULT 0,
  error         TEXT NULL,
  created_by    INT NULL,
  created_by_name VARCHAR(100) NULL,
  pushed_at     DATETIME NULL,
  confirmed_at  DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status (status),
  KEY idx_po (po_id)
);

-- Batch lines: one row per finishing_dispatches row swept into a batch.
-- dispatch_id UNIQUE = a dispatch row can NEVER be pushed twice (DB-level idempotency).
CREATE TABLE IF NOT EXISTS ee_dispatch_po_lines (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  batch_id      INT NOT NULL,
  dispatch_id   INT NOT NULL UNIQUE,
  lot_no        VARCHAR(50) NOT NULL,
  size_label    VARCHAR(20) NOT NULL,
  quantity      INT NOT NULL,
  lot_sku       VARCHAR(100) NULL,             -- cutting_lots.sku (style-level)
  ee_sku        VARCHAR(120) NULL,             -- resolved EasyEcom size-SKU (NULL = blocked)
  resolve_source VARCHAR(30) NULL,             -- 'map' | 'concat-verified' | NULL
  unit_cost     DECIMAL(10,2) NULL,            -- from ee_product_master.cost (may be NULL)
  mrp           DECIMAL(10,2) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_batch (batch_id),
  CONSTRAINT fk_eedpl_batch FOREIGN KEY (batch_id) REFERENCES ee_dispatch_po(id)
);

-- Unit price source: EasyEcom's own product master (user decision 2026-07-10).
-- The weekly master sync starts persisting these two fields.
ALTER TABLE ee_product_master
  ADD COLUMN cost DECIMAL(10,2) NULL AFTER description,
  ADD COLUMN mrp  DECIMAL(10,2) NULL AFTER cost;
