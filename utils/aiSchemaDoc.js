// The analyst's knowledge of the kotty_db schema and domain. Hand-curated —
// this brief is what turns generic text-to-SQL into an analyst that knows the
// factory. Keep it in sync with reality; the model can also run SHOW TABLES /
// DESCRIBE <table> to self-correct when this brief and the schema drift.

module.exports = `
# kotty_db — garment production + sales database (MySQL 8, read-only access)

## The business in one paragraph
KOTTY manufactures jeans/apparel. Fabric is CUT into lots, lots move through
production STAGES, finished pieces are DISPATCHED (mostly to the Faridabad
warehouse, which feeds the EasyEcom OMS and marketplaces). Workers are paid per
piece per stage. Sales/inventory data is mirrored nightly from EasyEcom.

## Core identifiers
- lot_no: unique lot id (e.g. 'ak5473'). manual_lot_number: the paper-register
  number (e.g. '1278km') — users often search by either.
- sku on production tables = STYLE (e.g. 'KTTWOMENSPANT981').
- EasyEcom size-SKU = style+size (e.g. 'KTTWOMENSPANT981XL') — a DIFFERENT id
  space; mapping lives in pm_sku_resolution (cl_sku + size_label → size_sku).

## Production pipeline (event-sourced — this is the truth)
Stage order: cutting → stitching → [jeans_assembly → washing → washing_in
(denim lots only)] → finishing. cutting_lots.flow_type is 'denim' or hosiery.

- cutting_lots: id, lot_no, manual_lot_number, sku (style), fabric_type,
  total_pieces, flow_type, user_id (cutter, join users), created_at,
  manual_cutting_date (physical cut date), remark.
- cutting_lot_sizes: cutting_lot_id, size_label, total_pieces.
  ⚠ A lot may have MULTIPLE rows for the SAME size_label (several patterns).
  ALWAYS aggregate: GROUP BY size_label, SUM(total_pieces).
- Event tables (append-only ledger): stitching_events, jeans_assembly_events,
  washing_events, washing_in_events, finishing_events. Columns: cutting_lot_id,
  event_type ENUM('approve','complete','reject'), pieces, parent_event_id,
  operator_id (join users), created_at. Per-size detail in *_event_sizes.
  Semantics: 'approve' = pieces TAKEN INTO the stage (this is also the payment
  event — it pays the UPSTREAM stage's worker); 'complete' = pieces finished at
  the stage; 'reject' with parent_event_id NULL = rejected at handover,
  NOT NULL = rejected during processing. WIP at a stage = approved − completed
  − inline rejects.
- {stage}_data + {stage}_data_sizes (e.g. stitching_data, finishing_data):
  per-OPERATOR completed batches (user_id = the master who did it, lot_no, sku,
  total_pieces, created_at). Use these for "who produced what".
- finishing_dispatches: finishing_data_id, lot_no, destination ('Warehouse',
  'Amazon', …), size_label, quantity, created_at. Warehouse dispatches flow to:
- ee_dispatch_po (+ ee_dispatch_po_lines): lot-wise challans/POs to EasyEcom.
  batch_ref 'KT-DISP-<id>-<lot_no>', lot_no, status ENUM draft/blocked/pushed/
  confirmed/failed/cancelled ('blocked' = a size has no EasyEcom SKU mapping;
  'confirmed' = warehouse GRN'd it in EasyEcom), po_id, total_qty, created_at.
- pm_lot_audit_log: admin corrections (flow_change/stage_reversal/qty_edit).

## Payments (per-piece piecework)
- stage_payments: the ledger of what workers earned (user_id worker, lot_no,
  sku, stage, pieces, rate, amount, created_at). One row per approve handover.
- stage_debits: deductions. stage_rates / stage_extra_rates: rate cards keyed
  by (sku, stage). If a rate is missing the payment row may be pending.
  DESCRIBE the table first if you need exact column names.

## Sales & inventory (EasyEcom mirror — size-SKU space)
⚠ THE #1 MISTAKE: sales tables use SIZE-SKUs. A question about a STYLE
(e.g. 'KTTWOMENSPANT261') finds NOTHING with sku = 'KTTWOMENSPANT261'.
ALWAYS match styles with sku LIKE 'KTTWOMENSPANT261%'. If any SKU lookup
returns 0 rows, retry with LIKE before concluding "no sales".

- ee_sales_daily — USE THIS FOR ALL SALES QUESTIONS (small + indexed on
  sale_date). Columns: sku, warehouse_id, sale_date (DATE), qty, revenue,
  source. ⚠ source has TWO values ('orders_api', 'mini_sales_report') that
  are two feeds of the SAME sales — summing both DOUBLE-COUNTS. Always
  filter source = 'orders_api' (the source of record).
  Top sellers: SELECT sku, SUM(qty) FROM ee_sales_daily WHERE source='orders_api'
  AND sale_date >= CURDATE() - INTERVAL 7 DAY GROUP BY sku ORDER BY 2 DESC LIMIT 10.
- ee_suborders: order LINES (sku size-SKU, quantity, selling_price, status,
  order_date, marketplace_sku, size, order_id → ee_orders). ⚠ order_date here
  is NOT indexed — a date-range scan TIMES OUT (10s cap). For date-bounded
  order questions JOIN ee_orders o ON o.order_id = s.order_id and filter
  o.order_date (indexed); or filter by sku first (indexed). Exclude
  status = 'Cancelled' when counting real sales; 'Returned' exists too.
- ee_orders: order headers (order_id, marketplace, order_status, order_date
  [indexed], total_amount, order_quantity, warehouse_id).
- ee_inventory_daily_snapshot: per size-SKU per day stock-on-hand snapshots.
- ee_stock_status / ee_inventory_health / ee_inventory_aging: current SOH,
  day cover, aging.
- ee_product_master: all ~90k EasyEcom SKUs (sku, active, cost, mrp).
Metrics: DRR = average daily sales (30-day AVG of ee_sales_daily.qty with
source='orders_api'); DOH/day-cover = SOH ÷ DRR.

## Users & roles
- users: id, username, is_active, role via roles table (users.role_id →
  roles.id, roles.name: 'operator','production_manager','finishing',
  'stitching_master', 'cutting_manager', …). DESCRIBE to confirm.

## Conventions & gotchas
- The session time zone is IST (+05:30): NOW() and all TIMESTAMP columns read
  in IST. Plain DATE(created_at) = CURDATE() style day-bounds are correct.
- Sizes: always GROUP BY size_label + SUM (duplicate label rows exist).
- lot_no matching is case-insensitive in practice; use LOWER() compare or =.
- Names of things users say: "challan"/"PO to warehouse" → ee_dispatch_po;
  "taken/accepted" → approve events; "completed/done" → complete events;
  "in hand / inline / WIP" → approved − completed − inline rejects.
- Prefer answering with small aggregated tables, not row dumps.
- Queries are killed at 10 seconds. On big tables (ee_suborders ~560k,
  ee_orders ~490k, ee_inventory_daily_snapshot ~3M rows) always filter on an
  indexed column (sku, order_id, sale_date, order_date on ee_orders) BEFORE
  aggregating. If a query times out, rewrite it against a smaller/indexed
  table (usually ee_sales_daily) instead of retrying the same query.
- If unsure a table/column exists: SHOW TABLES LIKE '%…%' or DESCRIBE <table>.
`;
