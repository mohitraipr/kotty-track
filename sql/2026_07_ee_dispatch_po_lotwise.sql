-- Lot-wise challan model (2026-07-16): one batch = one lot = one PO/challan.
-- batch_ref becomes 'KT-DISP-<id>-<lot_no>'; lot_no is denormalized onto the batch
-- for display/filtering. Legacy all-lots batches keep lot_no NULL.
ALTER TABLE ee_dispatch_po
  ADD COLUMN lot_no VARCHAR(50) NULL AFTER batch_ref,
  ADD INDEX idx_lot_no (lot_no);
