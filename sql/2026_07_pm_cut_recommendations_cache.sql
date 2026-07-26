-- Materialized cutting recommendations. computeCuttingRecommendations() is a
-- 300-2700s all-SKU aggregation; running it per dashboard load blew past the 60s
-- edge timeout (the "<?xml" JSON-parse error) and saturated the DB. The underlying
-- data (ee_sales_daily DRR, daily snapshot SOH) only changes nightly, so we compute
-- ONCE (nightly + on demand) and store the JSON result; the dashboard reads this.
CREATE TABLE IF NOT EXISTS pm_cut_recommendations_cache (
  cache_key   VARCHAR(40) NOT NULL PRIMARY KEY,   -- e.g. '30d:plain'
  payload     LONGTEXT NOT NULL,                  -- JSON array of recommendation rows
  row_count   INT NOT NULL DEFAULT 0,
  duration_ms INT NULL,                           -- how long the compute took
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
