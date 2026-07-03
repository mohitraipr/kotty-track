-- QC-Capture: errored searches (docs/plans/01-qcpass-extension.md).
-- When an operator scans/searches a tracking number and the RMS search fails
-- (e.g. "No Data Found"), the extension used to drop it entirely. This table
-- keeps a durable record of every errored tracking so it is never lost and can
-- be followed up / reconciled once the underlying issue is resolved (a later
-- successful capture for the same tracking = resolved).
--
-- One row per tracking (latest error wins) — re-scanning the same bad tracking
-- upserts the same row instead of piling up duplicates.
CREATE TABLE IF NOT EXISTS qc_search_errors (
  tracking_number  VARCHAR(120) NOT NULL,
  searched_by      INT NULL,
  search_status    VARCHAR(60)  NULL,
  error_reason     VARCHAR(255) NULL,
  raw_json         JSON NULL,
  searched_at      DATETIME NULL,
  ingested_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tracking_number),
  KEY idx_qse_searched_at (searched_at),
  KEY idx_qse_searched_by (searched_by),
  CONSTRAINT fk_qse_user FOREIGN KEY (searched_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
