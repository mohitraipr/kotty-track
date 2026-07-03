// Service worker: the DURABLE queue + authenticated sync. Every captured record is written to
// IndexedDB FIRST (survives crashes / reloads / offline), then synced to the kotty-track backend
// with retries. Nothing is lost: a record only leaves the queue after the backend confirms 200.
//
// Config lives in chrome.storage.local:
//   apiBase — backend base URL (defaults to prod below)
//   token   — Bearer token from POST /ext/qc/login (set by popup.js)
//
// A rolling copy of every record is also kept in a 'log' store so "Export CSV" still works after
// the records have synced and left the queue (the local safety net for /ext/qc/upload-csv).
const DEFAULT_API_BASE = 'https://kotty-track-fwlq5ofeza-el.a.run.app';
const BATCH = 100;
const LOG_CAP = 10000;
const DB_NAME = 'qc_capture', STORE = 'queue', LOG = 'log';

function apiBaseClean(base) { return String(base || DEFAULT_API_BASE).replace(/\/+$/, ''); }
function captureUrl(base) { return apiBaseClean(base) + '/ext/qc/capture'; }
function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiBase', 'token'], (r) => {
      resolve({ apiBase: apiBaseClean(r && r.apiBase), token: (r && r.token) || '' });
    });
  });
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'k', autoIncrement: true });
      if (!db.objectStoreNames.contains(LOG)) db.createObjectStore(LOG, { keyPath: 'k', autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function tx(store, mode, fn) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); }); }
const enqueue = (rec) => tx(STORE, 'readwrite', (s) => s.add({ rec, ts: Date.now() }));
function readAll() { return tx(STORE, 'readonly', (s) => { const out = []; s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push({ k: c.key, ...c.value }); c.continue(); } }; return out; }); }
const remove = (keys) => tx(STORE, 'readwrite', (s) => keys.forEach((k) => s.delete(k)));
// O(1) row count. NOTE: tx() resolves whatever fn(s) *returns*, so we must return a by-reference
// holder that the count request fills in — returning a primitive `n` would resolve its value at
// call time (0), before the request completes. (That old bug made the LOG_CAP trim never fire and
// the queue count always read 0.)
function storeCount(store) {
  return tx(store, 'readonly', (s) => { const req = s.count(); const h = { n: 0 }; req.onsuccess = () => { h.n = req.result; }; return h; })
    .then((h) => h.n);
}
const count = () => storeCount(STORE);

// Rolling log (durable copy for CSV export). Appends the record, then trims oldest rows > LOG_CAP.
const logCount = () => storeCount(LOG);
async function appendLog(rec) {
  await tx(LOG, 'readwrite', (s) => s.add({ rec, ts: Date.now() }));
  try {
    const n = await logCount();
    const extra = n - LOG_CAP;
    if (extra > 0) {
      await tx(LOG, 'readwrite', (s) => {
        let deleted = 0;
        s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c && deleted < extra) { c.delete(); deleted++; c.continue(); } };
      });
    }
  } catch (e) { /* trimming is best-effort */ }
}
function logAll() { return tx(LOG, 'readonly', (s) => { const out = []; s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value.rec); c.continue(); } }; return out; }); }

let synced = 0, offline = false, needsLogin = false, authMsg = '';
async function broadcast() {
  const queued = await count().catch(() => 0);
  const data = { queued, synced, offline, needsLogin, authMsg };
  const tabs = await chrome.tabs.query({ url: 'https://rejoyui.myntrainfo.com/*' });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'status', data }).catch(() => {});
}

let flushing = false;
async function flush() {
  if (flushing) return; flushing = true;
  try {
    const { apiBase, token } = await getConfig();
    if (!token) { needsLogin = true; authMsg = 'Please log in to sync captured returns.'; await broadcast(); return; }
    let items = await readAll();
    while (items.length) {
      const batch = items.slice(0, BATCH);
      let res;
      try {
        res = await fetch(captureUrl(apiBase), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ records: batch.map((b) => ({ ...b.rec, _type: b.type || b.rec._type || 'capture' })) }),
        });
      } catch (e) {
        offline = true; await broadcast(); break;            // network down — keep queue, retry later
      }
      if (res.status === 401) {
        needsLogin = true; authMsg = 'Session expired — please log in again.'; await broadcast(); break; // keep queue, stop
      }
      if (res.status === 403) {
        needsLogin = true; authMsg = 'This account lacks QC access (jitrgp role).'; await broadcast(); break; // keep queue, stop
      }
      if (!res.ok) { offline = true; await broadcast(); break; } // 5xx / other — keep queue, retry later
      await remove(batch.map((b) => b.k));
      synced += batch.length; offline = false; needsLogin = false; authMsg = '';
      items = items.slice(BATCH);
      await broadcast();
    }
  } finally { flushing = false; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'capture' || msg.type === 'pass' || msg.type === 'error') {
    const rec = { ...msg.record, _type: msg.type };
    enqueue(rec).then(() => appendLog(rec)).then(() => { broadcast(); flush(); });
  } else if (msg.type === 'getStatus') {
    count().then((queued) => sendResponse({ queued, synced, offline, needsLogin, authMsg })); return true;
  } else if (msg.type === 'exportRecords') {
    // return the durable rolling log (falls back to the live queue if the log is empty)
    logAll().then((recs) => {
      if (recs && recs.length) return recs;
      return readAll().then((items) => items.map((i) => i.rec));
    }).then((records) => sendResponse({ records })).catch(() => sendResponse({ records: [] }));
    return true;
  } else if (msg.type === 'flushNow') {
    needsLogin = false; authMsg = ''; flush(); if (sendResponse) sendResponse({ ok: true });
  }
});

// When the popup stores a fresh token, clear the re-login flag and drain the queue immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.apiBase)) {
    if (changes.token && changes.token.newValue) { needsLogin = false; authMsg = ''; }
    flush();
  }
});

// retry timer so offline/queued records always get delivered
chrome.alarms.create('flush', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flush') flush(); });
chrome.runtime.onStartup.addListener(flush);
chrome.runtime.onInstalled.addListener(flush);
