// ISOLATED-world content script: bridges the page-context interceptor (inject.js) to the
// privileged background worker, and shows the captured product/details on screen so the
// worker sees exactly what they're processing — like normal, plus the full record + sync status.
(function () {
  // ---------- on-screen panel ----------
  const PANEL_ID = 'qc-capture-panel';
  let panel, body, statusEl;
  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const css = document.createElement('style');
    css.textContent = `
      #${PANEL_ID}{position:fixed;bottom:16px;right:16px;width:340px;background:#0f172a;color:#e2e8f0;
        font:12px/1.45 Segoe UI,Tahoma,sans-serif;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647}
      #${PANEL_ID} .h{background:linear-gradient(90deg,#7c3aed,#a855f7);padding:8px 12px;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center}
      #${PANEL_ID} .h b{font-size:13px}
      #${PANEL_ID} .st{font-size:11px;opacity:.95}
      #${PANEL_ID} .bd{padding:10px 12px;max-height:340px;overflow:auto}
      #${PANEL_ID} .row{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid #1e293b}
      #${PANEL_ID} .k{color:#94a3b8}#${PANEL_ID} .v{color:#fff;font-weight:600;text-align:right;word-break:break-all}
      #${PANEL_ID} .pass{color:#22c55e}#${PANEL_ID} .warn{color:#f59e0b}
      #${PANEL_ID} .cfg{display:flex;justify-content:space-between;align-items:center;padding:7px 12px;background:#1e293b;border-bottom:1px solid #334155}
      #${PANEL_ID} .cfg label{display:flex;gap:7px;align-items:center;cursor:pointer;user-select:none}
      #${PANEL_ID} .cfg input{width:15px;height:15px;cursor:pointer}
      #${PANEL_ID} .mode{font-size:10px;font-weight:700;color:#f59e0b}
      #${PANEL_ID} .mode.on{color:#22c55e}
      #${PANEL_ID} .auth{padding:6px 12px;font-size:11px;background:#1e293b;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center;gap:8px}
      #${PANEL_ID} .auth .who{color:#a855f7;font-weight:700}
      #${PANEL_ID} .auth.warn{background:#3f1d1d}
      #${PANEL_ID} .auth .relogin{color:#f87171;font-weight:700}
      #${PANEL_ID} .bar{display:flex;gap:8px;padding:7px 12px;background:#1e293b;border-top:1px solid #334155;border-radius:0 0 10px 10px}
      #${PANEL_ID} .bar button{flex:1;padding:6px;border:0;border-radius:6px;background:#334155;color:#fff;font:600 11px/1 Segoe UI,sans-serif;cursor:pointer}
    `;
    document.documentElement.appendChild(css);
    panel = document.createElement('div'); panel.id = PANEL_ID;
    panel.innerHTML = `<div class="h"><b>QC Capture</b><span class="st" id="qc-st">queued 0 · synced 0</span></div>` +
      `<div class="auth" id="qc-auth"><span id="qc-who">not signed in</span><span class="relogin" id="qc-relogin" style="display:none">login needed</span></div>` +
      `<div class="cfg"><label><input type="checkbox" id="qc-autopass"> Auto-Pass on scan</label><span class="mode" id="qc-mode">capture only</span></div>` +
      `<div class="cfg"><label style="flex:1;gap:6px">Sort hub <input type="text" id="qc-sorthub" placeholder="e.g. BPF_RH" style="flex:1;min-width:0;background:#0f172a;border:1px solid #334155;border-radius:5px;color:#e2e8f0;padding:3px 6px;font:11px Segoe UI,sans-serif"></label></div>` +
      `<div class="cfg"><label style="gap:6px">Driver <select id="qc-drivemode" style="background:#0f172a;border:1px solid #334155;border-radius:5px;color:#e2e8f0;padding:3px 6px;font:11px Segoe UI,sans-serif"><option value="off">Off (passive)</option><option value="return">Customer Return</option><option value="rto">RTO</option></select></label><span class="mode" id="qc-drivest"></span></div>` +
      `<div class="cfg" id="qc-driverow" style="display:none"><input type="text" id="qc-drivescan" placeholder="Scan tracking → Enter" style="flex:1;min-width:0;background:#0f172a;border:1px solid #a855f7;border-radius:5px;color:#e2e8f0;padding:5px 8px;font:12px Segoe UI,sans-serif"></div>` +
      `<div class="bd" id="qc-bd"><div class="k">Scan/search a return…</div></div>` +
      `<div class="bar"><button id="qc-export">Export CSV</button></div>`;
    document.documentElement.appendChild(panel);
    body = panel.querySelector('#qc-bd'); statusEl = panel.querySelector('#qc-st');
    wireAutoPass(panel.querySelector('#qc-autopass'), panel.querySelector('#qc-mode'));
    wireSortHub(panel.querySelector('#qc-sorthub'));
    wireDriver(panel.querySelector('#qc-drivemode'), panel.querySelector('#qc-driverow'), panel.querySelector('#qc-drivescan'));
    wireExport(panel.querySelector('#qc-export'));
    renderAuth();
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.token || ch.user)) renderAuth(); });
  }

  // Show who's signed in (from chrome.storage.local, set by the popup) in the panel.
  function renderAuth() {
    const whoEl = panel && panel.querySelector('#qc-who');
    if (!whoEl) return;
    chrome.storage.local.get(['user'], (r) => {
      const u = r && r.user;
      whoEl.textContent = u ? ('signed in: ' + (u.username || ('#' + u.id))) : 'not signed in — open the extension to log in';
      whoEl.className = 'who';
    });
  }

  // Export CSV of the captured records straight from the panel (local backup safety net).
  function wireExport(btn) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'exportRecords' }, (resp) => {
        const records = (resp && resp.records) || [];
        if (!records.length) { btn.textContent = 'nothing to export'; setTimeout(() => (btn.textContent = 'Export CSV'), 1500); return; }
        const csv = (self.QCCsv ? self.QCCsv.toCsv(records) : '');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'qc-capture-' + stamp + '.csv';
        document.documentElement.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        btn.textContent = 'exported ' + records.length; setTimeout(() => (btn.textContent = 'Export CSV'), 1500);
      });
    });
  }

  // Auto-Pass toggle: OFF = capture/sync only (read-only). ON = also auto-pass each scanned item.
  // State is persisted and pushed to the page-context interceptor (inject.js) via window messages.
  // Broadcast the config (toggle + optional Pass-button selector override + sort hub) to inject.js.
  function pushCfg() {
    chrome.storage.local.get(['autopass', 'passSelector', 'sortHub', 'driveMode'], (r) => {
      try {
        window.postMessage({
          __qcCfg: true, autopass: !!(r && r.autopass),
          passSelector: (r && r.passSelector) || '',
          sortHub: (r && r.sortHub) || '',
          driveMode: (r && r.driveMode) || 'off',
        }, '*');
      } catch (e) {}
    });
  }
  function wireAutoPass(cb, modeEl) {
    if (!cb) return;
    const apply = (on) => {
      cb.checked = on;
      modeEl.textContent = on ? 'AUTO-PASS ON' : 'capture only';
      modeEl.classList.toggle('on', on);
      pushCfg();
    };
    chrome.storage.local.get('autopass', (r) => apply(!!(r && r.autopass)));
    cb.addEventListener('change', () => { chrome.storage.local.set({ autopass: cb.checked }); apply(cb.checked); });
  }
  // Sort hub: entered once, persisted, and reused for every RTO scan (auto-fill). When set,
  // inject.js sorts each RTO item on this screen before passing it.
  function wireSortHub(inp) {
    if (!inp) return;
    chrome.storage.local.get('sortHub', (r) => { inp.value = (r && r.sortHub) || ''; });
    const save = () => { chrome.storage.local.set({ sortHub: inp.value.trim() }); pushCfg(); };
    inp.addEventListener('change', save);
    inp.addEventListener('blur', save);
  }

  // ---------- driver mode ----------
  // Instead of scanning into the portal, the operator scans into OUR box; the extension drives
  // the portal's own scan path end to end: (RTO) sort → fill+enter tracking → fill+enter item
  // barcode → click Pass. It emulates the hardware scanner exactly: the portal reads a hidden
  // #scanner-input on an Enter keyup on document.body, so we set that value and dispatch Enter.
  let DRIVE_MODE = 'off';
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function wireDriver(sel, row, box) {
    if (!sel || !box) return;
    const apply = (mode) => {
      DRIVE_MODE = mode || 'off';
      sel.value = DRIVE_MODE;
      row.style.display = DRIVE_MODE === 'off' ? 'none' : '';
      const st = panel && panel.querySelector('#qc-drivest');
      if (st) { st.textContent = DRIVE_MODE === 'off' ? '' : ('DRIVING: ' + DRIVE_MODE.toUpperCase()); st.classList.toggle('on', DRIVE_MODE !== 'off'); }
      pushCfg();
      if (DRIVE_MODE !== 'off') setTimeout(() => { try { box.focus(); } catch (e) {} }, 50);
    };
    chrome.storage.local.get('driveMode', (r) => apply((r && r.driveMode) || 'off'));
    sel.addEventListener('change', () => { chrome.storage.local.set({ driveMode: sel.value }); apply(sel.value); });
    // scan → Enter drives the whole flow
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = box.value.trim();
      box.value = '';
      if (v) driveScan(v, DRIVE_MODE);
    });
  }

  // Emulate a hardware scan into the portal: set the hidden scanner buffer and fire Enter.
  function emitToPortalScanner(v) {
    const si = document.getElementById('scanner-input');
    if (!si) return false;
    try {
      si.focus();
      nativeValueSetter.call(si, String(v));
      si.dispatchEvent(new Event('input', { bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    } catch (e) { return false; }
    return true;
  }

  // Resolve on the next capture forwarded from inject.js (the portal's search response).
  let _captureWaiter = null;
  function waitForCapture(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { _captureWaiter = null; resolve(null); }, ms);
      _captureWaiter = (rec) => { clearTimeout(t); _captureWaiter = null; resolve(rec); };
    });
  }
  // Ask inject.js (page context) to run L1 sortation; resolve with its sort_* result.
  let _sortSeq = 0; const _sortWaiters = {};
  function requestSort(tracking) {
    return new Promise((resolve) => {
      const id = ++_sortSeq;
      const t = setTimeout(() => { delete _sortWaiters[id]; resolve(null); }, 8000);
      _sortWaiters[id] = (res) => { clearTimeout(t); delete _sortWaiters[id]; resolve(res); };
      try { window.postMessage({ __qcSortReq: true, id, tracking }, '*'); } catch (e) { resolve(null); }
    });
  }
  // Poll the DOM for the enabled+visible Pass button (same matching as inject's finder).
  function findPassButton() {
    const cands = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a.btn');
    for (const el of cands) {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      if (t === 'pass' || t === 'qc pass' || t === 'qcpass' || (t.length <= 16 && /\bpass\b/.test(t) && !/bypass|passbook|password/.test(t))) return el;
    }
    return null;
  }
  function waitForPassButton(ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const b = findPassButton();
        if (b) return resolve(b);
        if (Date.now() - start >= ms) return resolve(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function driveStatus(msg, warn) {
    const st = panel && panel.querySelector('#qc-drivest');
    if (st) { st.textContent = msg; st.classList.toggle('on', !warn); }
  }

  // The full driven flow: one operator scan → sorted, searched, item-filled, passed.
  async function driveScan(value, mode) {
    ensurePanel();
    try {
      // 1. RTO must be sorted before it can be passed — do it via the page context (inject.js).
      if (mode === 'rto') {
        driveStatus('sorting ' + value + '…');
        const sort = await requestSort(value);
        if (!sort || sort.sort_status !== 'SUCCESS') { driveStatus('SORT FAILED: ' + ((sort && sort.sort_status) || 'no response'), true); return; }
        driveStatus('sorted → LANE ' + (sort.sort_lane || '?'));
      }
      // 2. Drive the tracking scan into the portal and wait for its search response.
      driveStatus('searching ' + value + '…');
      const cap = waitForCapture(9000);
      if (!emitToPortalScanner(value)) { driveStatus('scanner-input not found — is the QC screen open?', true); return; }
      const rec = await cap;
      if (!rec) { driveStatus('no data for ' + value + ' (check the screen)', true); return; }
      // 3. Reveal Pass. RTO always needs the item-barcode step, so emit it right away; a customer
      //    return shows Pass straight after the tracking scan (fall back to the item step if not).
      let btn = null;
      if (rec.return_flow === 'rto' && rec.item_barcode) {
        driveStatus('item ' + rec.item_barcode + '…');
        await delay(300);
        emitToPortalScanner(rec.item_barcode);
        btn = await waitForPassButton(6000);
      } else {
        btn = await waitForPassButton(1500);
        if (!btn && rec.item_barcode) {
          driveStatus('item ' + rec.item_barcode + '…');
          emitToPortalScanner(rec.item_barcode);
          btn = await waitForPassButton(6000);
        }
      }
      if (!btn) { driveStatus('Pass button never appeared', true); return; }
      btn.click();
      driveStatus('PASSED ' + (rec.item_barcode || value));
    } catch (e) {
      driveStatus('driver error: ' + (e && e.message), true);
    } finally {
      const box = panel && panel.querySelector('#qc-drivescan');
      if (box && DRIVE_MODE !== 'off') setTimeout(() => { try { box.focus(); } catch (e) {} }, 50);
    }
  }
  const FIELDS = [
    ['Tracking', 'tracking_number'], ['Item Barcode', 'item_barcode'], ['Product', 'product_name'],
    ['Article No', 'article_no'], ['Style Id', 'style_id'], ['Size', 'size'], ['Price', 'price'],
    ['Return Type', 'return_type'], ['Return Mode', 'return_mode'], ['Return Status', 'return_status'],
    ['RMS Status', 'rms_status'], ['QC Action', 'qc_action'], ['Quality', 'quality'],
    ['Created', 'created_date'], ['Refund', 'refund_date'], ['Received', 'return_received_on'],
    ['Restock', 'return_restocked_on'], ['Logistics', 'logistics_status'], ['Courier', 'courier_code'],
    ['Return Hub', 'return_hub'], ['Dispatch WH', 'dispatch_wh'], ['Destination WH', 'return_destination_wh'],
    ['DC', 'delivery_center'], ['Ship City', 'ship_city'], ['Return Id', 'return_id'],
    ['OMS Release', 'oms_release_id'], ['SKU Id', 'sku_id'], ['SKU Code', 'sku_code'],
    ['Sort Hub', 'sort_hub'], ['Sort Lane', 'sort_lane'], ['Sort Lane Desc', 'sort_lane_desc'],
  ];
  function renderRecord(rec) {
    ensurePanel();
    // Prominent sort banner: the lane the operator must physically place this RTO item in.
    let banner = '';
    if (rec.sort_status) {
      const ok = rec.sort_status === 'SUCCESS';
      banner = ok
        ? `<div class="row"><span class="k">SORT → LANE</span><span class="v pass" style="font-size:15px">${String(rec.sort_lane || '?')}${rec.sort_lane_desc ? ' · ' + String(rec.sort_lane_desc) : ''}</span></div>`
        : `<div class="row"><span class="k">SORT FAILED</span><span class="v warn">${String(rec.sort_status)}</span></div>`;
    }
    body.innerHTML = banner + FIELDS.map(([label, key]) => {
      const v = rec[key] || '—';
      const cls = (key === 'logistics_status' && v === 'DELIVERED_TO_SELLER') || (key === 'sort_lane' && rec.sort_status === 'SUCCESS') ? 'pass' : '';
      return `<div class="row"><span class="k">${label}</span><span class="v ${cls}">${String(v)}</span></div>`;
    }).join('');
  }
  function markPassed(p) {
    ensurePanel();
    const tag = document.createElement('div');
    tag.className = 'row';
    tag.innerHTML = `<span class="k">QC PASS</span><span class="v ${p.pass_success ? 'pass' : 'warn'}">${p.pass_success ? 'PASSED → ' + (p.new_status || '') : 'FAILED: ' + (p.pass_error || '')}</span>`;
    body.prepend(tag);
  }
  // Show an errored scan on the panel so the operator sees it was captured (not silently dropped).
  function markError(e) {
    ensurePanel();
    body.innerHTML =
      `<div class="row"><span class="k">SEARCH ERROR</span><span class="v warn">${String(e.error_reason || 'No Data Found')}</span></div>` +
      `<div class="row"><span class="k">Tracking</span><span class="v">${String(e.tracking_number || '')}</span></div>` +
      `<div class="k" style="margin-top:6px">Logged — will sync so it isn't lost. Resolve & rescan to capture.</div>`;
  }
  function setStatus(s) {
    if (statusEl) statusEl.textContent = `queued ${s.queued || 0} · synced ${s.synced || 0}${s.offline ? ' · OFFLINE' : ''}`;
    const authEl = panel && panel.querySelector('#qc-auth');
    const reEl = panel && panel.querySelector('#qc-relogin');
    if (reEl && authEl) {
      const need = !!s.needsLogin;
      reEl.style.display = need ? '' : 'none';
      reEl.title = s.authMsg || '';
      reEl.textContent = need ? (s.authMsg || 'login needed') : '';
      authEl.classList.toggle('warn', need);
    }
  }

  // ---------- keep the scanner on the "Return Tracking ID" box ----------
  // The QC page renders TWO scan inputs side by side: "Return Tracking ID" and "Return ID".
  // After a pass/reload, focus can land in the Return ID box, so a scanned tracking barcode
  // goes into the wrong field. Locate the Tracking box by its label and focus it — but only
  // when nothing is actively being typed, so we never fight a deliberate click.
  function findInputByLabel(match) {
    const labels = document.querySelectorAll('label');
    for (const lab of labels) {
      const t = (lab.textContent || '').trim().toLowerCase();
      if (match(t)) {
        const forId = lab.getAttribute('for');
        if (forId) { const el = document.getElementById(forId); if (el) return el; }
        const cont = lab.closest('.u-field-container') || lab.parentElement;
        const inp = cont && cont.querySelector('input');
        if (inp) return inp;
      }
    }
    return null;
  }
  function findTrackingInput() {
    return findInputByLabel((t) => t === 'return tracking id' || (t.includes('tracking') && t.includes('id')));
  }
  function findReturnIdInput() {
    return findInputByLabel((t) => t === 'return id');
  }
  // RTO screen only: after a tracking scan the portal opens an "Item Barcode" input.
  function findItemBarcodeInput() {
    return findInputByLabel((t) => t.includes('barcode'));
  }
  function isUsableInput(inp) {
    if (!inp || inp.disabled || inp.readOnly) return false;
    const r = inp.getBoundingClientRect();
    return r.width > 0 && r.height > 0;   // rendered & visible
  }
  // Where the NEXT scan belongs. On the RTO screen an open, empty Item Barcode input takes
  // priority (tracking was already scanned); everywhere else it's the Tracking box.
  function findScanTarget() {
    const bar = findItemBarcodeInput();
    if (isUsableInput(bar) && !bar.value) return bar;
    return findTrackingInput();
  }

  // Clear a scan input the React way: the portal is a React app, so a plain `.value = ''`
  // only changes the DOM — React's state still holds the old text and re-renders it back.
  // Setting via the native value setter + firing an `input` event updates React's state too.
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function clearInput(inp) {
    if (!inp || !inp.value) return;
    try {
      nativeValueSetter.call(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }
  // Wipe every scan box so a failed value never blocks the next scan (or refocus).
  function clearScanInputs() {
    clearInput(findTrackingInput());
    clearInput(findReturnIdInput());
    const bar = findItemBarcodeInput();
    if (isUsableInput(bar)) clearInput(bar);
  }

  // Put the cursor on the scan target. `force` = a scan event just fired, so nobody is
  // mid-typing — steal focus even from an input that holds a (stale) value. Without `force`,
  // never interrupt an input that has text in it (a deliberate manual entry).
  // Returns true only when focus actually ended up on the target.
  function focusScanTarget(force) {
    const target = findScanTarget();
    if (!target) return false;
    if (document.activeElement === target) return true;   // already correct
    const a = document.activeElement;
    const busy = a && a.tagName === 'INPUT' && a !== target && a.value;
    if (busy && !force) return false;
    try { target.focus(); } catch (e) {}
    return document.activeElement === target;
  }
  // Poll until focus truly lands on the scan target and STAYS there (~1s stable). The portal
  // renders async — on the RTO screen the Item Barcode input can appear a beat after the
  // search response, changing the target mid-poll, so a single success isn't enough.
  function startTrackingFocus(force) {
    let tries = 0, stable = 0;
    const iv = setInterval(() => {
      stable = focusScanTarget(force) ? stable + 1 : 0;
      if (stable >= 3 || ++tries >= 20) clearInterval(iv);  // ~6s max
    }, 300);
  }
  // Permanent watchdog: whenever focus is dropped entirely (portal re-render leaves it on
  // <body>), re-aim at the scan target. Never fires while any input is focused, so it can't
  // fight a deliberate click into Return ID. In driver mode the operator scans into OUR box,
  // so keep focus there instead of the portal's input.
  setInterval(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT') return;   // don't fight active typing anywhere
    if (DRIVE_MODE !== 'off') {
      const box = panel && panel.querySelector('#qc-drivescan');
      if (box) { try { box.focus(); } catch (e) {} return; }
    }
    if (!a || a === document.body || a === document.documentElement) focusScanTarget(false);
  }, 1000);

  // ---------- bridge: page -> background ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    // inject.js just loaded and asked for the current config → push it.
    if (m.__qcReady === true) { pushCfg(); return; }
    // inject.js answered a driver sortation request.
    if (m.__qcSortRes === true) { const w = _sortWaiters[m.id]; if (w) w(m.result); return; }
    if (m.__qcCapture !== true) return;
    if (m.kind === 'capture') {
      renderRecord(m.payload); chrome.runtime.sendMessage({ type: 'capture', record: m.payload });
      // driver mode is awaiting this search result → hand it over; else re-aim portal focus.
      if (_captureWaiter) { _captureWaiter(m.payload); }
      else if (DRIVE_MODE === 'off') setTimeout(() => startTrackingFocus(true), 400);
    } else if (m.kind === 'pass') {
      markPassed(m.payload);
      chrome.runtime.sendMessage({ type: 'pass', record: m.payload });
      // after a pass the page clears/re-renders (or reloads) — wipe leftovers, re-aim at Tracking
      // (driver mode manages its own focus/box, so leave it alone there)
      setTimeout(() => { clearScanInputs(); if (DRIVE_MODE === 'off') startTrackingFocus(true); }, 400);
    } else if (m.kind === 'error') {
      markError(m.payload);
      chrome.runtime.sendMessage({ type: 'error', record: m.payload });
      // driver mode is awaiting this search → hand over null so it reports "no data" and recovers
      if (_captureWaiter) { _captureWaiter(null); }
      // failed scan: the portal leaves the bad value in the box and never clears it — wipe it
      // and refocus so the next scan works without a page refresh
      setTimeout(() => { clearScanInputs(); if (DRIVE_MODE === 'off') startTrackingFocus(true); }, 300);
    }
  });

  // ---------- background -> panel (queue/sync status) ----------
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'status') setStatus(msg.data); });
  // ask for current status on load
  try { chrome.runtime.sendMessage({ type: 'getStatus' }, (r) => { if (r) setStatus(r); }); } catch (e) {}
  document.addEventListener('DOMContentLoaded', () => { ensurePanel(); startTrackingFocus(); });
  ensurePanel();
  startTrackingFocus();
})();
