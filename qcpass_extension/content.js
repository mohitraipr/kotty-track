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
      `<div class="bd" id="qc-bd"><div class="k">Scan/search a return…</div></div>` +
      `<div class="bar"><button id="qc-export">Export CSV</button></div>`;
    document.documentElement.appendChild(panel);
    body = panel.querySelector('#qc-bd'); statusEl = panel.querySelector('#qc-st');
    wireAutoPass(panel.querySelector('#qc-autopass'), panel.querySelector('#qc-mode'));
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
  // Broadcast the config (toggle + optional Pass-button selector override) to inject.js.
  function pushCfg() {
    chrome.storage.local.get(['autopass', 'passSelector'], (r) => {
      try {
        window.postMessage({
          __qcCfg: true, autopass: !!(r && r.autopass),
          passSelector: (r && r.passSelector) || '',
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
  ];
  function renderRecord(rec) {
    ensurePanel();
    body.innerHTML = FIELDS.map(([label, key]) => {
      const v = rec[key] || '—';
      const cls = key === 'logistics_status' && v === 'DELIVERED_TO_SELLER' ? 'pass' : '';
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

  // ---------- bridge: page -> background ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    // inject.js just loaded and asked for the current config → push it.
    if (m.__qcReady === true) { pushCfg(); return; }
    if (m.__qcCapture !== true) return;
    if (m.kind === 'capture') { renderRecord(m.payload); chrome.runtime.sendMessage({ type: 'capture', record: m.payload }); }
    else if (m.kind === 'pass') {
      markPassed(m.payload);
      chrome.runtime.sendMessage({ type: 'pass', record: m.payload });
    }
  });

  // ---------- background -> panel (queue/sync status) ----------
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'status') setStatus(msg.data); });
  // ask for current status on load
  try { chrome.runtime.sendMessage({ type: 'getStatus' }, (r) => { if (r) setStatus(r); }); } catch (e) {}
  document.addEventListener('DOMContentLoaded', ensurePanel);
  ensurePanel();
})();
