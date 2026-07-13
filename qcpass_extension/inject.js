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
  // SORT_HUB: the L1 sortation hub the operator set once (e.g. "BPF_RH"). When set, an RTO
  // item is sorted (lane looked up) on THIS screen before it's passed — no screen switch.
  let AUTOPASS = false, PASS_SELECTOR = '', SORT_HUB = '';
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.__qcCfg === true) {
      AUTOPASS = !!m.autopass;
      if (typeof m.passSelector === 'string') PASS_SELECTOR = m.passSelector.trim();
      if (typeof m.sortHub === 'string') SORT_HUB = m.sortHub.trim();
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
      passHandled.delete(rec.item_barcode);           // don't leave the barcode stuck — allow a retry
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

  // RTO / courier-return QC responses have a DIFFERENT shape than customer returns:
  // no rmsRetunDetails; the item lives in orderReleaseItemData, logistics in shipmentDetails,
  // the lane in laneDetails, and style/size in productResponse.productOptions[].listings[].
  // (returnType comes back as "COURIER_RETURN", so we detect RTO by shape, not by that value.)
  function isRtoResponse(d) {
    return !!(d && !(d.rmsRetunDetails && d.rmsRetunDetails.length) &&
      (d.orderReleaseItemData && d.orderReleaseItemData.length) &&
      (d.shipmentDetails || d.laneDetails));
  }
  // laneDetails is an array of { "<omsReleaseId>": { code, description } } — pull this item's.
  function laneForOms(d, oms) {
    const ld = d && d.laneDetails;
    if (Array.isArray(ld)) {
      for (const e of ld) { if (e && e[oms]) return e[oms]; }
      if (ld[0] && typeof ld[0] === 'object') { const v = Object.values(ld[0])[0]; if (v && v.code) return v; }
    } else if (ld && ld.code) return ld;
    return {};
  }
  function extractRTO(j) {
    const d = (j && j.data) || {};
    const it = (d.orderReleaseItemData || [])[0] || {};
    const pr = (d.productResponse && ((d.productResponse[0]) || d.productResponse['0'])) || {};
    const sd = Array.isArray(d.shipmentDetails) ? (d.shipmentDetails[0] || {}) : (d.shipmentDetails || {});
    const skuId = String(pick(it, 'skuId'));
    // pick the productOption for THIS item's sku (not the first size) — same fix as customer returns
    const opts = pr.productOptions || [];
    const opt = opts.find((o) => o && String(o.skuId) === skuId) || {};
    const listing = (opt.listings && (Array.isArray(opt.listings) ? opt.listings[0] : opt.listings)) || {};
    const lane = laneForOms(d, it.omsReleaseId);
    return {
      return_flow: 'rto',
      tracking_number: pick(it, 'trackingNumber') || pick(sd, 'trackingNumber'),
      item_barcode: String(pick(it, 'itemBarcode')),
      return_id: String(pick(it, 'returnId')),
      oms_release_id: String(pick(it, 'omsReleaseId')),
      sku_id: skuId,
      sku_code: opt.skuCode || '',
      style_id: String(listing.styleId || pr.productId || ''),
      rms_status: pick(it, 'status'),
      return_status: pick(it, 'status'),
      status_code: pick(it, 'status'),
      qc_action: pick(it, 'qcActionCode'),
      return_type: pick(it, 'returnType'),
      supply_type: pick(it, 'supplyType'),
      article_no: opt.vendorArticleNo || pick(pr, 'articleNumber'),
      style_article_no: pick(pr, 'articleNumber'),
      product_name: pick(pr, 'productDisplayName', 'title'),
      price: String(pick(pr, 'price') || opt.price || ''),
      size: String(opt.value || opt.unifiedSize || ''),
      created_date: toDay(it.createdOn),
      shipped_on: toDay(it.shippedOn),
      return_received_on: toDay(it.returnReceivedOn),
      return_restocked_on: toDay(it.lastModifiedOn),
      warehouse_id: String(pick(it, 'warehouseId')),
      return_request_warehouse_id: String(pick(it, 'returnRequestWarehouseId')),
      // logistics straight from shipmentDetails — no separate getReturnLMSDetails call needed
      logistics_status: pick(sd, 'shipmentStatus'),
      courier_code: pick(sd, 'courierCode'),
      shipment_type: pick(sd, 'shipmentType'),
      active_leg: pick(sd, 'activeLegType'),
      ship_city: pick(sd, 'city'),
      ship_state: pick(sd, 'stateCode'),
      ship_pincode: pick(sd, 'pincode'),
      delivery_center: String(pick(sd, 'deliveryCenterId')),
      dispatch_wh: pick(sd, 'dispatchHubCode'),
      return_hub: pick(sd, 'rtoHubCode'),
      return_destination_wh: pick(sd, 'rtoHubCode', 'destinationHubCode'),
      // lane is already in the QC response (the item was L1-sorted) — surface it
      sort_lane: String(lane.code || ''),
      sort_lane_desc: String(lane.description || ''),
      captured_at: new Date().toISOString(),
    };
  }

  // The searched value the operator scanned lives in the GET search2 URL, e.g.
  //   ...search2?query[q]=trackingNumber.eq:5718708979&...&receiveShipmentQuery[q][entityBarcode]=5718708979
  // so we can recover it even when the search fails (No Data Found) and there's no response body.
  function searchedValueFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const eb = u.searchParams.get('receiveShipmentQuery[q][entityBarcode]');
      if (eb && eb.trim()) return eb.trim();
      const q = u.searchParams.get('query[q]') || '';         // "trackingNumber.eq:VALUE"
      const idx = q.indexOf('.eq:');
      if (idx >= 0) { const v = q.slice(idx + 4).trim(); if (v) return v; }
    } catch (e) {}
    return '';
  }

  // `searchedValue` is what the operator scanned (from the URL). On a failed/empty search we
  // record it as an ERROR so the tracking is never lost (later resolved by a successful capture).
  const isRTO = (rec) => !!(rec && rec.return_flow === 'rto');

  // L1 sortation, run from the QC screen: look up the lane for this RTO tracking number at the
  // operator's hub (SORT_HUB). This is the SAME single GET the L1Sortation screen fires, so it
  // performs the sort/lane assignment without the operator leaving QC. Idempotent (safe to retry).
  // Fills rec.sort_* and returns true only on a SUCCESS lane lookup.
  async function doSortation(rec) {
    if (!SORT_HUB || !rec || !rec.tracking_number) return false;
    rec.sort_hub = SORT_HUB;
    try {
      const url = `${API}/l1Sortation/fetchLaneDetailsForRtoTrackId/${encodeURIComponent(rec.tracking_number)}?hubCode=${encodeURIComponent(SORT_HUB)}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-myntra-app-name': 'rejoy', 'x-myntra-client-id': 'rejoy', 'x-myntra-module-name': 'L1Sortation', 'x-myntra-rejoy-service': 'rms.l1sortation.findRtoSearchByTrackNo' },
      });
      const j = await res.json();
      const ok = !!(j && j.status && j.status.statusType === 'SUCCESS');
      const ld = (j && j.data && j.data.laneDetails) || {};
      rec.sort_lane = String(ld.code || '');
      rec.sort_lane_desc = String(ld.description || '');
      rec.sort_warehouse = String(ld.sellerWarehouseName || '');
      rec.sort_status = ok ? 'SUCCESS' : String((j && j.status && j.status.statusMessage) || 'ERROR');
      return ok;
    } catch (e) {
      rec.sort_status = 'ERROR: ' + (e && e.message);
      return false;
    }
  }

  async function handleSearch(j, searchedValue) {
    try {
      const failed = !j || (j.status && j.status.statusType && j.status.statusType !== 'SUCCESS');
      if (!failed) {
        const d = (j && j.data) || {};
        // RTO/courier-return responses have their own shape & extractor; everything else is a
        // customer return. This is what fixes blank style_id/return_type on RTO items.
        const rec = isRtoResponse(d) ? extractRTO(j) : extractSearch(j);
        if (rec.item_barcode || rec.tracking_number) {
          if (isRTO(rec)) {
            // logistics already came in shipmentDetails; sort here so the operator never leaves QC.
            const sortOk = SORT_HUB ? await doSortation(rec) : true;
            post('capture', rec);
            // pass only when the sort succeeded (or no hub configured) — never pass an unsorted RTO
            if (AUTOPASS && sortOk) doAutoPass(rec);
          } else {
            await enrichLogistics(rec);
            post('capture', rec);
            if (AUTOPASS) doAutoPass(rec);
          }
          return;
        }
      }
      // failed OR nothing extracted → don't drop it; log the errored tracking
      if (searchedValue) {
        const reason = (j && j.status && (j.status.statusMessage || j.status.errorMessage)) || 'No Data Found';
        post('error', {
          tracking_number: String(searchedValue),
          search_status: (j && j.status && j.status.statusType) || 'ERROR',
          error_reason: String(reason),
          searched_at: new Date().toISOString(),
        });
      }
    } catch (e) {}
  }

  function handlePass(j, reqBody) {
    try {
      const ok = j && j.status && j.status.statusType === 'SUCCESS';
      let body = {}; try { body = reqBody ? JSON.parse(reqBody) : {}; } catch (e) {}
      const newStatus = ok && j.data && j.data[0] ? (j.data[0].status || '') : '';
      // pass failed server-side → un-mark the barcode so a re-scan can auto-pass again
      // (previously it stayed in passHandled forever, and only a page refresh recovered)
      if (!ok && body.itemBarcode) passHandled.delete(String(body.itemBarcode));
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

  // All the QC-portal search masks that resolve to the SAME worms orderReleaseItem search
  // backend (per the portal's boot config), so one extractor handles every screen:
  //   searchReturnDetails/search[2]        -> customer-return screen
  //   search2 / search / returnSearch      -> RTO screen (tracking scan)
  //   findSearchDetailOrderReleaseItem/... -> RTO screen (item-barcode scan)
  const SEARCH_RE = /\/qcSearch\/(searchReturnDetails\/search2?|search2?(\?|$)|returnSearch|findSearchDetailOrderReleaseItem\/search)/;
  const isSearchUrl = (url) => SEARCH_RE.test(url);
  // Pass endpoints: updateReturnRestocked (customer return + RTO RpcQcFlow) and
  // updateQCStatus (rms returnLine update, the older QC flow's pass).
  const isPassUrl = (url) => url.includes('/qcSearch/updateReturnRestocked') || url.includes('/qcSearch/updateQCStatus');

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
      const init = args[1] || {};
      if (isSearchUrl(url)) {
        const sv = searchedValueFromUrl(url);
        p.then((r) => r.clone().json().then((j) => handleSearch(j, sv)).catch(() => handleSearch(null, sv)));
      } else if (isPassUrl(url)) {
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
        if (isPassUrl(_url)) {
          armPrintSuppress();   // also kill the print popup when the page itself does a pass
        }
      } catch (e) {}
      return send.call(this, body);
    };
    xhr.addEventListener('load', function () {
      const isSearch = isSearchUrl(_url);
      const isPass = isPassUrl(_url);
      if (!isSearch && !isPass) return;
      // Parse defensively — an errored search may be non-JSON; we still want to log it.
      let j = null;
      try {
        if (!xhr.responseType || xhr.responseType === 'text') j = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        else if (xhr.responseType === 'json') j = xhr.response;
      } catch (e) { j = null; }
      if (isSearch) handleSearch(j, searchedValueFromUrl(_url));  // j may be null → logs the error
      else if (j) handlePass(j, _body);
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ask content.js for the current Auto-Pass config (handles either load order)
  try { window.postMessage({ __qcReady: true }, '*'); } catch (e) {}

  console.log('%c[QC Capture] active — capturing full return data on this page', 'color:#a855f7;font-weight:bold');
})();
