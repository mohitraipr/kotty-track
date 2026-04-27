-- Remove Old Payment Tables Migration
-- These tables are replaced by the unified stage_payments system
-- Run this AFTER verifying the new system is working

-- Step 1: Backup old data (optional - run these SELECT statements to export if needed)
-- SELECT * FROM stitching_payments_contract;
-- SELECT * FROM stitching_rates;
-- SELECT * FROM washing_item_rates;
-- SELECT * FROM washing_invoices;
-- SELECT * FROM washing_invoice_items;

-- Step 2: Drop old tables (will break stitchingPaymentRoutes.js and washingPaymentRoutes.js)
DROP TABLE IF EXISTS stitching_payments_contract;
DROP TABLE IF EXISTS stitching_operation_payments;
DROP TABLE IF EXISTS stitching_rates;
DROP TABLE IF EXISTS stitching_operation_rates;
DROP TABLE IF EXISTS washing_item_rates;
DROP TABLE IF EXISTS washing_invoice_items;
DROP TABLE IF EXISTS washing_invoices;

-- Note: After running this, remove or update these route files:
-- - routes/stitchingPaymentRoutes.js (old stitching payment system)
-- - routes/washingPaymentRoutes.js (old washing payment system)
