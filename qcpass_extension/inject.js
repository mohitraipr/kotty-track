// MAIN-world script: runs in the rejoyui page context (uses the live session).
// It piggybacks on the page's own QC API calls (no extra login, no token juggling):
//   - searchReturnDetails/search2  -> the page calls this when a worker searches/scans a return
//   - updateReturnRestocked        -> the page calls this when a worker clicks "Pass"
// For each searchReturnDetails response it also fires getReturnLMSDetails to add the
// Logistics Status (DELIVERED_TO_SELLER etc.), assembles the FULL record, and posts it to
// the isolated content script via window.postMessage.
(function () {
  const API = 'https://spectrum-babylon-api.myntrainfo.com/api/rejoyui';
  const SOURCE_ID = '2297', TENANT_ID = '4019';

  // Auto-Pass config, pushed from content.js. OFF = capture only; ON = auto-pass each scanned item.
  // PASS_SELECTOR (optional) lets an operator pin the exact Pass button via a CSS selector when
  // the text-based finder isn't enough — set chrome.storage.local.passSelector.
  let AUTOPASS = false, PASS_SELECTOR = '';
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.__qcCfg === true) {
      AUTOPASS = !!m.autopass;
      if (typeof m.passSelector === 'string') PASS_SELECTOR = m.passSelector.trim();
    }
  });

  // ---- print-popup suppression ----
  // Clicking Pass (or our auto-pass) makes the app open a print/label window. Suppress any
  // window.open / window.print that fires in the ~3s right after a pass, so no print page appears.
  let suppressOpenUntil = 0;
  const armPrintSuppress = () => { suppressOpenUntil = Date.now() + 3000; };
  const origOpen = window.open;
  window.open = function (...a) {
    if (Date.now() < suppressOpenUntil) {
      console.log('%c[QC Capture] print popup suppressed', 'color:#f59e0b');
      // return a harmless stub so page code like w.document.write(...).print() doesn't throw
      return { closed: true, close() {}, focus() {}, print() {}, document: { write() {}, close() {}, open() {} }, location: {} };
    }
    return origOpen.apply(this, a);
  };
  const origPrint = window.print;
  window.print = function () {
    if (Date.now() < suppressOpenUntil) { console.log('%c[QC Capture] print() suppressed', 'color:#f59e0b'); return; }
    return origPrint && origPrint.apply(this, arguments);
  };

  // ---- auto-pass: click the PAGE'S OWN "Pass" button (keeps Myntra's UI in sync) ----
  // Why not call updateReturnRestocked directly? Doing so passes the item in the backend but
  // leaves Myntra's React UI unaware — the tracking input stays disabled until a manual refresh,
  // and a subsequent manual Pass click fails ("already QC'd"). Clicking the real button instead
  // runs the page's own flow: it re-enables the input for the next scan, and our fetch/XHR hook
  // below still captures the pass result to the panel/DB. No refresh, no desync.
  const passHandled = new Set();  // barcodes we've already auto-passed this session (no double-pass)

  function isClickable(el) {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;   // visible
  }

  // Find the enabled, visible "Pass" control. Explicit selector wins; else match button text.
  function findPassButton() {
    if (PASS_SELECTOR) {
      try { const el = document.querySelector(PASS_SELECTOR); if (isClickable(el)) return el; } catch (e) {}
    }
    const cands = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a.btn');
    // exact-label pass first
    for (const el of cands) {
      if (!isClickable(el)) continue;
      const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      if (t === 'pass' || t === 'qc pass' || t === 'qcpass') return el;
    }
    // looser: a short label containing the word "pass" (excluding lookalikes)
    for (const el of cands) {
      if (!isClickable(el)) continue;
      const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      if (t && t.length <= 16 && /\bpass\b/.test(t) && !/bypass|passbook|password/.test(t)) return el;
    }
    return null;
  }

  // Poll for the enabled+visible Pass button up to `timeoutMs` (the page renders it after search).
  function waitForPassButton(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const b = findPassButton();
        if (b) return resolve(b);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  async function doAutoPass(rec) {
    try {
      if (!rec || !rec.item_barcode) return;
      if (rec.qc_action) return;                      // already QC'd — never re-pass
      if (passHandled.has(rec.item_barcode)) return;  // de-dupe rapid duplicate searches
      passHandled.add(rec.item_barcode);
      const btn = await waitForPassButton(6000);
      if (!btn) {
        console.log('%c[QC Capture] auto-pass: Pass button not found — click it manually, or set passSelector', 'color:#f59e0b');
        passHandled.delete(rec.item_barcode);         // allow a retry on the next search
        return;
      }
      armPrintSuppress();
      btn.click();  // page's own pass flow → updateReturnRestocked → captured by our hook below
      console.log('%c[QC Capture] auto-pass: clicked the page Pass button', 'color:#22c55e');
    } catch (e) {
      post('pass', { item_barcode: String(rec.item_barcode || ''), pass_success: false, pass_error: 'auto-pass error: ' + (e && e.message), passed_at: new Date().toISOString() });
    }
  }

  const post = (kind, payload) => {
    try { window.postMessage({ __qcCapture: true, kind, payload }, '*'); } catch (e) {}
  };

  function pick(o, ...keys) { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return ''; }
  // Dates arrive as epoch-ms (numbers) OR ISO strings ("2026-06-17T06:41:04.000+0000").
  // Return a clean YYYY-MM-DD (local day) for both; '' when missing.
  function toDay(v) {
    if (v == null || v === '') return '';
    let dt;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) dt = new Date(Number(v));
    else dt = new Date(String(v));
    if (isNaN(dt.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  // Pull the full field set out of a searchReturnDetails response (mapped from the REAL shape).
  function extractSearch(j) {
    const d = (j && j.data) || {};
    const rd = (d.rmsRetunDetails || [])[0] || {};
    const it = (d.orderReleaseItemData || [])[0] || {};
    const pr = (d.productResponse && (d.productResponse['0'] || d.productResponse[0])) || {};
    const tr = rd.returnTrackingDetailsEntry || {};
    const oh = rd.returnOnHoldDetailsEntry || {};
    const qc = rd.returnQcDetailsEntry || {};
    const refund = rd.returnRefundDetailsEntry || {};
    const line = (rd.returnLineEntries || [])[0] || {};

    const skuId = String(pick(line, 'skuId') || pick(it, 'skuId'));
    // SIZE: productOptions lists ALL sizes of the style — pick the one matching THIS item's skuId,
    // not the first option (that bug showed 26 instead of 32).
    let size = '', skuCode = '', vendorArticle = '';
    const opts = pr.productOptions || [];
    let opt = opts.find((o) => o && String(o.skuId) === skuId);
    if (!opt) opt = opts.find((o) => o && o.name === 'Size'); // fallback
    if (opt) {
      size = String(opt.value || opt.unifiedSize || '');
      skuCode = opt.skuCode || '';
      // the article no shown on the QC screen is the per-size VENDOR article (e.g. KTTWOMENSPANT473XL)
      vendorArticle = opt.vendorArticleNo || opt.vendorArticleNumber || '';
    }

    return {
      tracking_number: pick(it, 'trackingNumber') || pick(tr, 'trackingNo'),
      item_barcode: String(pick(it, 'itemBarcode')),
      return_id: String(pick(rd, 'id') || pick(it, 'returnId')),
      oms_release_id: String(pick(it, 'omsReleaseId') || pick(line, 'orderReleaseId')),
      sku_id: skuId,
      sku_code: skuCode,
      style_id: String(pick(line, 'styleId')),
      rms_status: pick(it, 'status'),
      status_code: pick(rd, 'statusCode') || pick(line, 'statusCode'),
      return_status: pick(rd, 'statusCode') || pick(line, 'statusCode'),
      qc_action: pick(qc, 'qcAction', 'qcActionCode') || pick(it, 'qcActionCode'),
      quality: pick(qc, 'quality') || pick(it, 'quality'),
      qc_done_by: pick(qc, 'qcDoneBy') || pick(it, 'qcDoneBy'),
      return_type: pick(rd, 'returnType') || pick(it, 'returnType'),
      return_mode: pick(rd, 'returnMode'),
      supply_type: pick(line, 'supplyType') || pick(it, 'supplyType'),
      on_hold: (oh.onHold || rd.isOnHold) ? 'Yes' : 'No',
      store_order_id: String(pick(rd, 'orderId', 'storeOrderId')),
      display_order_id: pick(rd, 'displayStoreOrderId'),
      warehouse_id: String(pick(line, 'warehouseId') || pick(it, 'warehouseId') || pick(tr, 'warehouseId')),
      return_request_warehouse_id: String(pick(it, 'returnRequestWarehouseId')),
      article_no: vendorArticle || pick(pr, 'articleNumber'),
      style_article_no: pick(pr, 'articleNumber'),
      product_name: pick(pr, 'productDisplayName', 'title'),
      price: String(pick(line, 'unitPrice') || pick(pr, 'price')),
      size,
      created_date: toDay(rd.createdOn),
      refund_date: toDay(refund.refundedOn),
      refund_amount: String(pick(refund, 'refundAmount')),
      refund_mode: pick(refund, 'refundMode'),
      shipped_on: toDay(it.shippedOn),
      return_received_on: toDay(it.returnReceivedOn) || toDay(tr.receivedOn),
      return_restocked_on: toDay(rd.lastModifiedOn) || toDay(line.lastModifiedOn),
      // logistics — filled by getReturnLMSDetails below
      logistics_status: '', courier_code: '', return_hub: '', return_facility: '',
      delivery_center: '', dispatch_wh: '', return_destination_wh: '',
      ship_city: '', ship_state: '', ship_pincode: '', shipment_type: '', active_leg: '',
      captured_at: new Date().toISOString(),
    };
  }

  async function enrichLogistics(rec) {
    if (!rec.return_id) return rec;
    try {
      const res = await fetch(`${API}/qcSearch/getReturnLMSDetails/${rec.return_id}?sourceId=${SOURCE_ID}&tenantId=${TENANT_ID}`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-myntra-app-name': 'rejoy', 'x-myntra-client-id': 'rejoy', 'x-myntra-module-name': 'QcSearch', 'x-myntra-rejoy-service': 'lms.qcSearch.getReturnLMSDetails' },
      });
      const j = await res.json();
      const r = (j && j.data && j.data[0]) || null;
      if (r) {
        rec.logistics_status = r.shipmentStatus || '';
        rec.courier_code = r.courierCode || '';
        rec.return_hub = r.returnHubCode || '';
        rec.return_facility = String(r.returnFacilityId || '');
        rec.delivery_center = String(r.deliveryCenterId || '');
        rec.dispatch_wh = String(r.receivedAtWH || '');
        rec.return_destination_wh = String(r.returnFacilityId || r.lastReceivedHubCode || '');
        rec.ship_city = r.city || '';
        rec.ship_state = r.stateCode || '';
        rec.ship_pincode = r.pincode || '';
        rec.shipment_type = r.shipmentType || '';
        rec.active_leg = r.activeLegType || '';
      }
    } catch (e) { /* leave logistics blank; backend still gets the record */ }
    return rec;
  }

  async function handleSearch(j) {
    try {
      if (!j || (j.status && j.status.statusType && j.status.statusType !== 'SUCCESS')) return;
      const rec = extractSearch(j);
      if (!rec.item_barcode && !rec.tracking_number) return;
      await enrichLogistics(rec);
      post('capture', rec);
      if (AUTOPASS) doAutoPass(rec);   // auto-pass the scanned item when the toggle is ON
    } catch (e) {}
  }

  function handlePass(j, reqBody) {
    try {
      const ok = j && j.status && j.status.statusType === 'SUCCESS';
      let body = {}; try { body = reqBody ? JSON.parse(reqBody) : {}; } catch (e) {}
      const newStatus = ok && j.data && j.data[0] ? (j.data[0].status || '') : '';
      post('pass', {
        item_barcode: String(body.itemBarcode || ''),
        oms_release_id: String(body.omsReleaseId || ''),
        qc_action: body.qcActionCode || '',
        quality: body.quality || '',
        desk_code: body.qcDeskCode || '',
        warehouse_id: String(body.returnRequestWarehouseId || ''),
        pass_success: !!ok,
        new_status: newStatus,
        pass_error: ok ? '' : (j && j.status ? j.status.statusMessage : 'pass failed'),
        passed_at: new Date().toISOString(),
      });
    } catch (e) {}
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
      const init = args[1] || {};
      if (url.includes('/qcSearch/searchReturnDetails/search2')) {
        p.then((r) => r.clone().json().then(handleSearch).catch(() => {}));
      } else if (url.includes('/qcSearch/updateReturnRestocked')) {
        armPrintSuppress();   // also kill the print popup when the page itself does a pass
        p.then((r) => r.clone().json().then((j) => handlePass(j, init.body)).catch(() => {}));
      }
    } catch (e) {}
    return p;
  };

  // ---- hook XHR (page may use axios/XHR) ----
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '', _body = null;
    const open = xhr.open;
    xhr.open = function (method, url, ...rest) { _url = url || ''; return open.call(this, method, url, ...rest); };
    const send = xhr.send;
    xhr.send = function (body) {
      _body = body;
      try {
        if (_url.includes('/qcSearch/updateReturnRestocked')) {
          armPrintSuppress();   // also kill the print popup when the page itself does a pass
        }
      } catch (e) {}
      return send.call(this, body);
    };
    xhr.addEventListener('load', function () {
      try {
        if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json') return;
        const txt = xhr.responseType === 'json' ? null : xhr.responseText;
        const j = xhr.responseType === 'json' ? xhr.response : (txt ? JSON.parse(txt) : null);
        if (!j) return;
        if (_url.includes('/qcSearch/searchReturnDetails/search2')) handleSearch(j);
        else if (_url.includes('/qcSearch/updateReturnRestocked')) handlePass(j, _body);
      } catch (e) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ask content.js for the current Auto-Pass config (handles either load order)
  try { window.postMessage({ __qcReady: true }, '*'); } catch (e) {}

  console.log('%c[QC Capture] active — capturing full return data on this page', 'color:#a855f7;font-weight:bold');
})();
