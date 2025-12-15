-- Migration to add panel_name column to existing cartons table
-- Run this if the cartons table already exists without panel_name

USE kotty_track;

-- Add panel_name column if it doesn't exist
ALTER TABLE cartons ADD COLUMN IF NOT EXISTS panel_name VARCHAR(255) NOT NULL DEFAULT '' AFTER packed_by;

-- Add index for panel_name
ALTER TABLE cartons ADD INDEX IF NOT EXISTS idx_panel_name (panel_name);

-- Update existing records to have a default panel name (optional)
-- UPDATE cartons SET panel_name = 'Default Panel' WHERE panel_name = '' OR panel_name IS NULL;

SELECT 'Migration completed: panel_name column added to cartons table' as Status;
