# Finishing dispatch → EasyEcom inventory (challan/GRN design)

**Goal:** when finishing dispatches a lot to our warehouse, the pieces should enter our
OMS (EasyEcom) as a *documented inbound* — a challan-backed receipt, not a blind stock
edit — so warehouse inventory is tracked from the original production record. EasyEcom
then syncs that stock to every marketplace, and production planning can treat dispatched
lots as truly closed.

**Stakes:** whatever we push becomes live sellable stock on Myntra/Flipkart/Amazon/… within
EasyEcom's sync cycle. A wrong SKU or double-push oversells on marketplaces. This design is
therefore gated, idempotent, and blocks on anything unresolved.

---

## 1. What EasyEcom's API offers (verified against the live V2.1 Postman collection, 2026-07-10)

| Option | Endpoints | Verdict |
|---|---|---|
| **A. PO + GRN (recommended)** | `POST /WMS/Cart/CreatePurchaseOrder` → `POST /wms/QueueGrnApi` (with `purchase_order_id`) → `GET /wms/CheckGrnStatus?queue_id=` → `GET /Grn/V2/getGrnDetails` | Full document trail: our dispatch challan number becomes the PO `referenceCode`/`docNumber`; the receipt is a GRN with invoice number + status. This IS the "challan" flow in OMS terms. |
| B. Direct GRN (no PO) | `POST /wms/QueueGrnApi` with `{vendor_id, items[]}` only | Simpler; still a documented GRN, but no PO/challan reference binding the receipt to our dispatch document. Acceptable fallback. |
| C. Bulk inventory update | `POST /inventory/bulkInventoryUpdate` `{skus:[{sku, quantity}]}` | **Rejected.** Absolute quantity set, races with live sales, no document trail. Exactly the "insecure" update we must avoid. |
| D. Stock Transfer Note | `POST /webhook/v2/createOrder` (`orderType: stocktransferorder`) | Only for moves *between EasyEcom locations*. The factory is not an EasyEcom location — not applicable. |

### Verified payloads

**CreatePurchaseOrder** → returns `{data:{poId}}`
```json
{ "vendorId": <kotty-production-vendor>, "referenceCode": "KT-DISP-<dispatch_batch_id>",
  "docNumber": "<our challan no>", "expDeliveryDate": "YYYY-MM-DD", "createOrUpdate": "I",
  "isCancel": 0, "shippingCost": 0, "updateTaxRate": 1,
  "items": [ { "lineItemNumber": "1", "sku": "<EASYECOM SIZE-SKU>", "quantity": "N",
               "unitPrice": <transfer cost>, "taxRate": "0|5|12", "taxType": 1 } ] }
```

**QueueGrnApi (against PO)** → returns `queue_id`; poll `CheckGrnStatus`
```json
{ "vendor_id": <same vendor>, "purchase_order_id": <poId>,
  "items": [ { "sku": "<EASYECOM SIZE-SKU>", "quantity": N, "shelf": "<receiving bin>",
               "cost": <unit cost>, "mrp": <mrp>, "batch_code": "<lot_no>",
               "ean": "", "expiry_date": "", "mfg_date": "", "days_to_expire": "" } ] }
```
Note `batch_code = lot_no` — the production lot travels into the OMS as the batch, giving
full lot-level traceability inside EasyEcom.

**Auth (corrected 2026-07-10):** the `X-API-Key` is **account-level (primary only)** — the
same `EASYECOM_API_KEY` already in our secrets goes on every call. Location scoping happens in
the JWT: `POST /access/token {email, password, location_key}` minted with the **Faridabad
location_key** puts the GRN in the Faridabad context. This is exactly the model
`utils/easyecomPullWorker.js` already uses for per-warehouse mini-sales pulls (secondary
location_keys as "Company Token"), so **no new credentials or keys are needed**. Rate limits
are tier-based (429); reuse the 5-retry exponential backoff from `utils/easyecomReturnsClient.js`.

---

## 2. What we have today

`finishing_dispatches` rows: `(finishing_data_id, lot_no, destination, size_label, quantity,
total_sent, sent_at)` — per-lot, per-size, with a destination select (Warehouse / Ajio /
Myntra / … / custom) posted from the finishing screen (`POST /finishingdashboard/event/dispatch`).

**The hard problem is SKU resolution.** Dispatches are keyed `lot SKU + size_label`; EasyEcom
needs its exact size-level SKU. We already own this mapping problem in production planning
(`pm_sku_resolution`, `utils/skuResolver.js`, `resolveSizeSku` in `utils/onOrder.js`) and we
know it has an unresolved tail. **Policy: only rows that resolve through the resolver map are
eligible to push. Unresolved rows go to an exceptions queue — never guessed, never concat-built.**

---

## 3. Recommended flow (per dispatch batch)

```
finishing dispatch saved (destination = Warehouse)
        │
        ▼
[1] rows grouped into a dispatch batch → ee_dispatch_grn row (status=draft)
        │  resolve lot+size → EasyEcom SKU via pm_sku_resolution
        │  any unresolved line → status=blocked, listed on the review screen
        ▼
[2] OPERATOR REVIEW SCREEN (approval gate)
        │  shows challan no, lot, per-SKU qty, destination warehouse
        │  operator clicks "Push to EasyEcom"
        ▼
[3] CreatePurchaseOrder (referenceCode = KT-DISP-<batch id>, docNumber = challan no)
        ▼
[4] QueueGrnApi against poId (batch_code = lot_no, shelf = receiving bin)
        ▼
[5] poll CheckGrnStatus(queue_id) until success/failure
        ▼
[6] verify via Grn/V2/getGrnDetails → store grn_id, mark batch = confirmed
        ▼
[7] production planning: confirmed batch closes the lot's in-flight quantity
```

### Safety design
- **Idempotency ledger** — new table `ee_dispatch_grn(batch_id, dispatch_ids, po_id,
  queue_id, grn_id, status[draft|blocked|pushed|confirmed|failed], payload_json, error,
  created_by, timestamps)`. A dispatch row can belong to exactly one non-failed batch →
  retries can never double-GRN. `referenceCode` is unique per batch on the EasyEcom side too.
- **Approval gate first, automation later** — phase 1 is operator-clicked. Only after weeks of
  clean pushes do we consider auto-push (behind `EE_GRN_AUTOPUSH`).
- **Feature flag** `EE_GRN_PUSH` (default off) + warehouse credentials via env/secrets
  (`--update-secrets` only, per deploy policy).
- **Blocked ≠ dropped** — unresolved SKUs / API failures stay visible on the review screen
  until resolved and re-pushed.
- **Verification loop** — a batch is only `confirmed` when `getGrnDetails` shows the GRN;
  a nightly job re-checks `pushed` batches that never confirmed.
- **No deletes/edits after push** — corrections happen as EasyEcom-side adjustments, logged.

### Decisions taken care of by design
- `batch_code = lot_no` → lot traceability inside the OMS.
- `unitPrice`/`cost` → nominal transfer price from a small config (finance can set); taxRate 0
  for stock transfer unless finance says otherwise.
- GRN shelf → a fixed "PRODUCTION-INWARD" receiving bin so warehouse QC can putaway properly.

---

## 4. Production-planning payoff

Once dispatches flow as GRNs:
1. **SOH becomes truthful automatically** — finished goods appear in EasyEcom stock (and the
   snapshot CSVs the PM pull worker already ingests) without manual entry.
2. **In-flight netting closes cleanly** — a confirmed batch decrements the lot's in-flight
   quantity in the PM closed-loop math (the gap documented around `pm_open_cutting_lots`).
3. **DRR/DOH math sees new stock same-day** instead of whenever someone manually updates.

---

## 5. Phased implementation

| Phase | Scope | Risk |
|---|---|---|
| 0 | One-time: pick/create vendor via API (`getVendors`/`CreateVendor`); sandbox-test one PO+GRN with a test SKU; observe sellable-vs-hold + marketplace sync behaviour | none (test SKU) |
| 1 | `ee_dispatch_grn` table + resolver join + **review screen** (list batches, blocked lines) — no pushing yet | none |
| 2 | Push pipeline (steps 3–6) behind `EE_GRN_PUSH`, operator-approved, Warehouse-destination dispatches only | low (gated) |
| 3 | PM closed-loop hookup (confirmed batch → in-flight closure) | low |
| 4 | Optional: auto-push, second warehouse, QC-hold bin flow | later |

## 6. Decisions (locked 2026-07-10)

1. **Warehouse:** Faridabad (warehouse_id 173983). Needs its API credentials (email/password/
   location_key + X-API-Key) stored as Cloud Run secrets.
2. **Unit price:** fetched from EasyEcom itself — `Get Master Product` exposes `cost` and
   `mrp` per SKU; we cache them (daily refresh via the pull worker) and echo them back on the
   PO/GRN lines. No local price table. Lines whose SKU has no cost in the master are flagged
   on the review screen (pushed with cost 0 only on explicit operator confirm).
3. **Sellable-immediately vs QC hold:** resolved empirically by the Phase-0 test (below) —
   EasyEcom accounts differ on whether GRN'd stock lands as Available instantly or sits in
   putaway/Hold until warehouse staff putaway. We observe, then decide the bin strategy.
4. **Approver:** the **finishing role** — the review/approve screen lives on the finishing
   dashboard, gated `isFinishingMaster`. (Per the audience rule: the screen's users must be
   able to reach everything on it.)

### Investigated and set aside: EasyEcom "Production Order"
`POST /webhook/v2/createOrder` with `orderType: "productionorder"` exists, but its payload is
outbound-order-shaped (customer, payment, discounts) and its inventory semantics are
undocumented. The PO+GRN path is the documented inbound with a full trail — we stay on it.
Worth one question to EasyEcom support later, nothing more.

## 8. MODEL REVISION (2026-07-10, after live Phase-0): PO-only — warehouse approves by GRN

The first live test created both the PO **and** the GRN via API. Decision: **too automatic** —
inventory entered the OMS with no human at the warehouse confirming physical receipt.

**Final model:** kotty-track creates **only the Purchase Order** (the challan). The Faridabad
team receives the physical dispatch and makes the **GRN manually in the EasyEcom UI against
that PO** — their normal receiving screen. Stock enters EasyEcom (→ marketplaces) only when
the warehouse confirms the goods. This also collapses Phase 2: no GRN client, no queue
polling — the pipeline is CreatePurchaseOrder + a confirmation job that polls
`Grn/V2/getGrnDetails?created_after=…` and matches `po_id` to mark our dispatch batches
**confirmed** when the warehouse GRNs them (and flags batches unreceived after N days).

### Live Phase-0 artifacts & findings
- Vendor **Kotty Production** — vendor_c_id **289541**, code **V002** (created via API;
  GSTIN/PAN mirrored from KOTTY LIFESTYLE; email kotty4133@gmail.com).
- Test 1 (superseded): PO **2061826** `KT-DISP-TEST-001` + API GRN **2221812** (In Progress,
  1 × KTTBLUETOP768M @ ₹200, MRP 1299, batch TEST-PHASE0, bin `default`). To clean up:
  warehouse cancels GRN 2221812 in the UI, then the PO can be cancelled.
- Test 2 (the real model): PO **2061975** `KT-DISP-TEST-002`, 1 × KTTBLUETOP768M — awaiting
  manual warehouse GRN.
- API quirks (bake into the client): `CreatePurchaseOrder.vendorId` = the vendor **code**
  ("V002") while `QueueGrnApi.vendor_id` = the **numeric** vendor_c_id; `expDeliveryDate`
  must be strictly after today; receiving bin is lowercase **`default`**; GRN-queue success
  returns `queueId` at the TOP level of the response; EE rejects inwarding beyond PO quantity
  ("can't inward more than PO quantity") — a built-in second layer of double-push protection;
  a PO with any GRN against it cannot be cancelled.
- Vendors are visible across location contexts, but ALL PO/GRN calls should use the
  **Faridabad-context JWT** (`EASYECOM_LOCATION_KEY` = ee30270084289 = Faridabad, per
  `utils/easyecomReturnsClient.js` WAREHOUSES map).
- Test SKU: **KTTBLUETOP768M** (product_id 34048953, active, plain product, 0 stock @Faridabad,
  0 sales 90d; Myntra listing myntra.com/36828826, Amazon B0FQ2VB5LL; control listing
  myntra.com/38188898 = SCK-prefixed sibling SKU).
- Product master (98,072 SKUs) has NO per-SKU filter — cost/mrp at scale come from extending
  the nightly `ee_product_master` sync with cost+mrp columns.

## 7. Phase-0 protocol — "how would we know?"

The GRN→sellable behaviour is account-configuration-dependent, so we measure it with one test
SKU before any real lot:

1. Pick/create a **test SKU** in EasyEcom that is listed on at most one low-risk marketplace
   (or none).
2. Record its baseline: `STATUS_WISE_STOCK_REPORT` (Available/Hold/Reserved) + the marketplace
   listing quantity.
3. Push the flow end-to-end: CreatePurchaseOrder (qty 5) → QueueGrnApi → CheckGrnStatus.
4. Observe, in order:
   - `getGrnDetails` — GRN created, status, invoice number (the document trail exists).
   - `STATUS_WISE_STOCK_REPORT` — did +5 land in **Available** immediately, or in **Hold**
     until a putaway? This answers decision 3.
   - The warehouse team's EasyEcom WMS screen — does a putaway task appear for shelf
     PRODUCTION-INWARD?
   - The marketplace seller panel after EasyEcom's next sync — did the listing quantity rise?
5. Reverse the test (adjust the 5 units back out in EE UI) and write the observed behaviour
   into this doc before Phase 2.

**Prerequisites (mostly automated now):**
- Vendor: resolved via API — `GET /wms/V2/getVendors` to reuse a suitable existing vendor, or
  `POST /wms/CreateVendor` to create "Kotty Production" in one call (recommended: dedicated
  vendor keeps production inbounds out of fabric-vendor purchase reports). No UI work.
- Credentials: none needed — account `EASYECOM_API_KEY` + JWT minted with the Faridabad
  location_key (already the pull-worker model).
- From the business: just **name the test SKU** (ideally listed on at most one low-risk
  marketplace).
