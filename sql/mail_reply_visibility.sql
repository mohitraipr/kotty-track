-- Visibility for the mail auto-reply cron.
--
--   1) skip_reason on each email row → so we can tell WHY an email
--      sat in 'initial' status (no order id? no awb? no video?)
--   2) mail_reply_runs table → permanent per-run record (today the
--      stats live only in console logs and rotate out)
--
-- Safe to re-run: ALTER uses IF NOT EXISTS via information_schema check,
-- CREATE uses IF NOT EXISTS. Idempotent.

-- ─── 1) skip_reason column on mail_replies ──────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'mail_replies'
     AND COLUMN_NAME  = 'skip_reason'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE mail_replies
     ADD COLUMN skip_reason ENUM(
       ''no_order_id'',
       ''no_awb'',
       ''no_video'',
       ''our_own'',
       ''already_replied'',
       ''not_target_class'',
       ''error''
     ) NULL AFTER classification,
     ADD COLUMN run_id BIGINT NULL AFTER skip_reason,
     ADD INDEX idx_mail_replies_skip_reason (skip_reason),
     ADD INDEX idx_mail_replies_status_created (status, created_at)',
  'SELECT ''skip_reason already exists'' AS info'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ─── 2) mail_reply_runs — one row per cron / manual invocation ──────
CREATE TABLE IF NOT EXISTS mail_reply_runs (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  started_at      DATETIME     NOT NULL,
  finished_at     DATETIME     NULL,
  triggered_by    ENUM('cron', 'manual') NOT NULL DEFAULT 'cron',
  triggered_user_id BIGINT     NULL,
  fetched         INT          NOT NULL DEFAULT 0,
  processed       INT          NOT NULL DEFAULT 0,
  replied         INT          NOT NULL DEFAULT 0,
  errors          INT          NOT NULL DEFAULT 0,
  skipped_own     INT          NOT NULL DEFAULT 0,
  skipped_already_replied INT  NOT NULL DEFAULT 0,
  skipped_no_order_id INT      NOT NULL DEFAULT 0,
  skipped_no_awb  INT          NOT NULL DEFAULT 0,
  skipped_no_video INT         NOT NULL DEFAULT 0,
  duration_ms     INT          NULL,
  error_message   TEXT         NULL,
  stats_json      JSON         NULL,
  PRIMARY KEY (id),
  KEY idx_mail_reply_runs_started (started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
