-- Fix flow_type column in cutting_lots table
-- Error: "Data truncated for column 'flow_type' at row 1"
-- This means the column exists but has wrong type (probably empty ENUM or short VARCHAR)

-- First check current column definition:
-- SHOW COLUMNS FROM cutting_lots WHERE Field = 'flow_type';

-- Fix: Change to VARCHAR(20) to support 'denim' and 'hosiery' values
ALTER TABLE cutting_lots
MODIFY COLUMN flow_type VARCHAR(20) DEFAULT NULL;

-- Verify the fix:
-- SHOW COLUMNS FROM cutting_lots WHERE Field = 'flow_type';
