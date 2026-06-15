-- Self-healing catch-up pull: single-runner daily claim.
--
-- The nightly EasyEcom pull cannot rely on the in-process node-cron because
-- Cloud Run scales to zero (no container alive at 02:30 IST) and throttles CPU
-- after a request returns (a fire-and-forget pull dies mid-run). Instead, the
-- first app request after the 02:30 IST cutoff claims the day's run here and
-- fires a synchronous self-call to /internal/run-pull. The PRIMARY KEY on
-- run_date guarantees exactly one of the (up to 10) containers runs it.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS pm_pull_claims (
  run_date    DATE NOT NULL,
  status      ENUM('running','done','failed') NOT NULL DEFAULT 'running',
  attempts    INT NOT NULL DEFAULT 1,
  claimed_at  DATETIME NOT NULL,
  finished_at DATETIME NULL,
  claimed_by  VARCHAR(64) NULL,        -- Cloud Run revision / hostname of the winner
  message     VARCHAR(255) NULL,       -- last error on failure
  PRIMARY KEY (run_date),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
