-- Manual (handwritten / physical) lot number on cutting lots.
--
-- The system-generated cutting_lots.lot_no (e.g. "jo1") remains the IMMUTABLE
-- internal key used by every downstream join and all piece-tracking math.
-- manual_lot_number is a DISPLAY label only: it replaces lot_no in what users
-- see, falling back to lot_no for lots that have not been mapped yet.
--
-- Run manually (this repo has no migration runner).

ALTER TABLE cutting_lots
  ADD COLUMN manual_lot_number VARCHAR(64) NULL AFTER lot_no;

CREATE INDEX idx_cutting_lots_manual_lot ON cutting_lots (manual_lot_number);

-- Snapshot the manual number onto each challan line at issue time, for
-- display / printing / search. lot_no STAYS the real system key that the
-- issued/remaining computation (LEFT JOIN dci.lot_no = c.lot_no) depends on.
ALTER TABLE dc_challan_items
  ADD COLUMN manual_lot_number VARCHAR(64) NULL AFTER lot_no;
