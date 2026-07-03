// Popup: login against /ext/qc/login, persist token+user, show account/sync state, logout,
// and Export CSV (local backup) of the captured records. Nothing here touches the QC page.
const DEFAULT_API_BASE = 'https://kotty-track-fwlq5ofeza-el.a.run.app';
const apiBaseClean = (b) => String(b || DEFAULT_API_BASE).replace(/\/+$/, '');

const $ = (id) => document.getElementById(id);
const loginView = $('login-view'), acctView = $('account-view');

function getLocal(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }
function setLocal(obj) { return new Promise((r) => chrome.storage.local.set(obj, r)); }
function removeLocal(keys) { return new Promise((r) => chrome.storage.local.remove(keys, r)); }
function sendBg(msg) { return new Promise((r) => { try { chrome.runtime.sendMessage(msg, (resp) => { void chrome.runtime.lastError; r(resp); }); } catch (e) { r(null); } }); }

function showMsg(el, text, cls) { el.className = 'msg' + (cls ? ' ' + cls : ''); el.textContent = text || ''; }

async function render() {
  const { token, user, apiBase } = await getLocal(['token', 'user', 'apiBase']);
  $('base').value = apiBase || '';
  if (token && user) {
    loginView.style.display = 'none';
    acctView.style.display = 'block';
    $('who-name').textContent = user.username || ('#' + user.id);
    refreshStatus();
  } else {
    loginView.style.display = 'block';
    acctView.style.display = 'none';
  }
}

async function refreshStatus() {
  const s = await sendBg({ type: 'getStatus' }) || {};
  $('s-queued').textContent = s.queued || 0;
  $('s-synced').textContent = s.synced || 0;
  let state = 'idle', cls = '';
  if (s.needsLogin) { state = 're-login needed'; cls = 'warn'; }
  else if (s.offline) { state = 'offline — retrying'; cls = 'warn'; }
  else if (s.queued) { state = 'syncing…'; }
  else { state = 'synced'; cls = 'ok'; }
  $('s-state').textContent = state;
  showMsg($('acct-msg'), s.needsLogin ? (s.authMsg || 'Please log in again.') : '', cls === 'ok' ? '' : cls);
}

async function doLogin() {
  const username = $('u').value.trim(), password = $('p').value;
  const base = apiBaseClean($('base').value.trim());
  if (!username || !password) { showMsg($('login-msg'), 'Enter username and password.', 'err'); return; }
  $('login-btn').disabled = true;
  showMsg($('login-msg'), 'Logging in…', '');
  try {
    const res = await fetch(base + '/ext/qc/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, device_label: 'chrome-ext' }),
    });
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (res.status === 403) { showMsg($('login-msg'), 'This account lacks QC access (jitrgp role).', 'err'); return; }
    if (res.status === 401) { showMsg($('login-msg'), 'Wrong username or password.', 'err'); return; }
    if (!res.ok || !body.ok || !body.token) { showMsg($('login-msg'), 'Login failed (HTTP ' + res.status + ').', 'err'); return; }
    await setLocal({ token: body.token, user: body.user || { username }, apiBase: base });
    $('p').value = '';
    showMsg($('login-msg'), '', '');
    await render();
  } catch (e) {
    showMsg($('login-msg'), 'Network error: ' + (e && e.message || e), 'err');
  } finally {
    $('login-btn').disabled = false;
  }
}

async function doLogout() {
  await removeLocal(['token', 'user']);
  await render();
}

async function doExport() {
  showMsg($('acct-msg'), 'Preparing CSV…', '');
  const resp = await sendBg({ type: 'exportRecords' }) || {};
  const records = resp.records || [];
  if (!records.length) { showMsg($('acct-msg'), 'No captured records to export yet.', 'warn'); return; }
  const csv = QCCsv.toCsv(records);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = 'qc-capture-' + stamp + '.csv';
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  try {
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => { void chrome.runtime.lastError; });
    showMsg($('acct-msg'), 'Exported ' + records.length + ' records.', 'ok');
  } catch (e) {
    // fallback: anchor download
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    showMsg($('acct-msg'), 'Exported ' + records.length + ' records.', 'ok');
  }
}

$('login-btn').addEventListener('click', doLogin);
$('p').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logout-btn').addEventListener('click', doLogout);
$('export-btn').addEventListener('click', doExport);
render();
setInterval(() => { if (acctView.style.display !== 'none') refreshStatus(); }, 2000);
