-- Stage Payment System Updates
-- Add rate_configured flag and payment_remark columns

-- Check if columns exist before adding (MySQL 8.0+ supports IF NOT EXISTS for columns via procedure)
-- For safety, we'll use ALTER IGNORE or check manually

-- Add rate_configured column (1 = rate was found, 0 = rate not configured)
ALTER TABLE stage_payments
  ADD COLUMN IF NOT EXISTS rate_configured TINYINT(1) DEFAULT 1 AFTER total_amount;

-- Add payment_remark column (accounts team adds remark when marking as paid)
ALTER TABLE stage_payments
  ADD COLUMN IF NOT EXISTS payment_remark TEXT AFTER paid_by;

-- Update existing records to have rate_configured = 1 (assuming they were created with valid rates)
UPDATE stage_payments SET rate_configured = 1 WHERE rate_configured IS NULL;
