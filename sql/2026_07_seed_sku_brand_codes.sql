-- The cutting SKU builder's Brand dropdown used to be hardcoded to
-- KTT / KOTTY / NW / CC. It is now driven by sku_brand_codes (so brands added
-- via SKU Brands / PO Creator show up in cutting too). Seed the four hardcoded
-- classics so the switch loses nothing — NW and CC were not yet in the table.
-- Idempotent. APPLIED TO PROD 2026-07-18.
INSERT IGNORE INTO sku_brand_codes (code, description, is_active) VALUES
  ('KTT',   '', 1),
  ('KOTTY', '', 1),
  ('NW',    '', 1),
  ('CC',    '', 1);
