-- Migration: Add lot_no and filler_stage columns to indent_requests
-- Purpose: Allow stage workers to create indents linked to specific lots

-- Add lot_no column
ALTER TABLE indent_requests
ADD COLUMN lot_no VARCHAR(50) DEFAULT NULL AFTER filler_id;

-- Add filler_stage column (stitching, jeans_assembly, finishing, cutting, operator)
ALTER TABLE indent_requests
ADD COLUMN filler_stage VARCHAR(50) DEFAULT NULL AFTER lot_no;

-- Add remark column for filler to add context (if not exists)
-- Note: remark column may already exist for store manager, check first

-- Index for lot-based queries
CREATE INDEX idx_indent_requests_lot ON indent_requests(lot_no);

-- Index for stage-based filtering
CREATE INDEX idx_indent_requests_stage ON indent_requests(filler_stage);
