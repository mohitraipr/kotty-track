-- Manual cutting date: the actual day the lot was cut, which can differ from
-- created_at (cutters sometimes cut on one day and upload on another).
-- Cutting-only field — surfaced at lot creation, the operator edit-lot form,
-- and the PIC report. Nullable.
ALTER TABLE cutting_lots
  ADD COLUMN manual_cutting_date DATE NULL AFTER manual_lot_number;
