-- Covering index for the selling-days aggregation over ee_inventory_daily_snapshot
-- (2.78M rows). The query `SELECT sku, COUNT(DISTINCT snapshot_date) ...
-- WHERE snapshot_date >= ? AND qty > 0 GROUP BY sku` previously did a range scan
-- on idx_snapshot_date + a temporary table + filesort. With (sku, snapshot_date, qty)
-- it becomes a COVERING index scan grouped by sku — no temp table, no filesort
-- (EXPLAIN: "Using index"). Adds ~116MB; DB stays ~1.6GB of 15GB provisioned.
--
-- APPLIED TO PROD 2026-07-17 via online DDL (ALGORITHM=INPLACE, LOCK=NONE, ~30s,
-- non-blocking). Idempotent-ish: drop first if re-running.
ALTER TABLE ee_inventory_daily_snapshot
  ADD INDEX idx_snap_sku_date_qty (sku, snapshot_date, qty), ALGORITHM=INPLACE, LOCK=NONE;
