-- One-time remediation for KT-DISP-2 (run manually AFTER deploying the lot-wise
-- challan model and applying 2026_07_ee_dispatch_po_lotwise.sql).
--
-- KT-DISP-2 mixed 12 lots (83 lines, 10,449 pcs) and sat blocked because 9 lots had
-- unresolved SKUs — freezing the 3 fully-resolved lots. Cancelling the batch and
-- releasing its lines lets the lot-wise sweep (cron, or "Sweep now" on the transfers
-- screen) rebuild them as one batch per lot: resolved lots push immediately, blocked
-- lots block only themselves.
--
-- Safe because: batch 2 was never pushed (no PO exists in EasyEcom), and deleting the
-- lines releases the dispatch_id UNIQUE locks so the same dispatches can re-sweep.

UPDATE ee_dispatch_po SET status='cancelled', error='superseded by lot-wise challans (design doc §9)' WHERE id = 2 AND status = 'blocked';
DELETE FROM ee_dispatch_po_lines WHERE batch_id = 2;
