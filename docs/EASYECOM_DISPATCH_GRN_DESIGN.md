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

**Auth:** V2.1 — `POST /access/token {email, password, location_key}` → JWT; every call sends
`Authorization: Bearer <jwt>` **and** `X-API-Key`. The `location_key` must be the **receiving
warehouse's** (Faridabad wh 173983 / Delhi wh 176318 — each has its own credentials; the
PRIMARY key `ne30265212961` is the account-level one used by the pull worker). Rate limits are
tier-based (429); reuse the 5-retry exponential backoff from `utils/easyecomReturnsClient.js`.

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
| 0 | One-time: create "Kotty Production" vendor in EasyEcom UI; get warehouse API creds; sandbox-test one PO+GRN with a test SKU; confirm marketplace sync behaviour | none (test SKU) |
| 1 | `ee_dispatch_grn` table + resolver join + **review screen** (list batches, blocked lines) — no pushing yet | none |
| 2 | Push pipeline (steps 3–6) behind `EE_GRN_PUSH`, operator-approved, Warehouse-destination dispatches only | low (gated) |
| 3 | PM closed-loop hookup (confirmed batch → in-flight closure) | low |
| 4 | Optional: auto-push, second warehouse, QC-hold bin flow | later |

## 6. Open decisions (need the business call)

1. **Which warehouse first** — Faridabad (173983) or Delhi (176318)? (Creds per warehouse.)
2. **Transfer price** on the PO/GRN (finance visibility) — nominal ₹1, actual cost, or style cost?
3. **Sellable immediately?** GRN'd stock becomes Available → marketplaces. If warehouse QC
   should happen first, we GRN into a hold bin and putaway manually.
4. **Who approves pushes** — which operator role sees the review screen.
