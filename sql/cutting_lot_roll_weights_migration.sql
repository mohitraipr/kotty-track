-- Add full and remaining weight tracking for cutting lot rolls
ALTER TABLE cutting_lot_rolls
  ADD COLUMN full_weight DECIMAL(10,2) NULL AFTER total_pieces,
  ADD COLUMN remaining_weight DECIMAL(10,2) NULL AFTER full_weight;
