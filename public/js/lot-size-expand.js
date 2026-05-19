/* lot-size-expand.js
 *
 * Shared progressive-enhancement script: turns any <tr data-lot-no="..."> in
 * any dashboard table into an expandable row that loads per-size data
 * on-demand from GET /operator/api/lot-sizes?lot_no=<lotNo>.
 *
 * Markup contract (add to each view, in the row's first <td>):
 *   <td>
 *     <button type="button"
 *             class="lse-toggle btn btn-link btn-sm p-0"
 *             aria-expanded="false"
 *             aria-label="Show size breakdown">
 *       <span class="lse-chevron">&#9654;</span>
 *     </button>
 *   </td>
 * Then add `data-lot-no="..."` on the <tr>. The script auto-wires every row.
 *
 * The cache is per-row (kept on the row element), so re-expanding never
 * re-fetches.
 */
(function () {
  'use strict';

  var ENDPOINT = '/operator/api/lot-sizes';

  // Inject minimal CSS once.
  function injectStyles() {
    if (document.getElementById('lse-styles')) return;
    var css = ''
      + '.lse-toggle{background:none;border:none;cursor:pointer;color:inherit;}'
      + '.lse-toggle:focus{outline:2px solid #d4826a;outline-offset:2px;}'
      + '.lse-chevron{display:inline-block;transition:transform .15s ease;font-size:.85em;}'
      + '.lse-toggle[aria-expanded="true"] .lse-chevron{transform:rotate(90deg);}'
      + '.lse-detail-row > td{background:#faf7f2;padding:12px 18px;border-top:0;}'
      + '.lse-detail-wrap{margin:0;}'
      + '.lse-detail-head{font-size:12px;font-weight:600;color:#5a4a3a;margin-bottom:6px;letter-spacing:.02em;}'
      + '.lse-detail-table{width:auto;min-width:60%;border-collapse:collapse;font-size:12px;background:#fff;border:1px solid #e6dfd2;border-radius:6px;overflow:hidden;}'
      + '.lse-detail-table th,.lse-detail-table td{padding:6px 10px;text-align:right;border-bottom:1px solid #f0e9da;}'
      + '.lse-detail-table th:first-child,.lse-detail-table td:first-child{text-align:left;font-weight:600;}'
      + '.lse-detail-table thead th{background:#f3ece0;color:#3d2f20;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.04em;border-bottom:1px solid #e6dfd2;}'
      + '.lse-detail-table tbody tr:last-child td{border-bottom:0;}'
      + '.lse-detail-table tbody tr:hover td{background:#fdfaf3;}'
      + '.lse-empty{font-size:12px;color:#8a7860;font-style:italic;}'
      + '.lse-spinner{display:inline-block;width:14px;height:14px;border:2px solid #d4826a33;border-top-color:#d4826a;border-radius:50%;animation:lse-spin .7s linear infinite;vertical-align:middle;margin-right:6px;}'
      + '@keyframes lse-spin{to{transform:rotate(360deg);}}';
    var style = document.createElement('style');
    style.id = 'lse-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function fmt(n) {
    n = Number(n) || 0;
    return n.toLocaleString();
  }

  function renderDetail(data) {
    var wrap = document.createElement('div');
    wrap.className = 'lse-detail-wrap';

    if (!data || !data.sizes || !data.sizes.length) {
      var p = document.createElement('div');
      p.className = 'lse-empty';
      p.textContent = 'No size detail available.';
      wrap.appendChild(p);
      return wrap;
    }

    var head = document.createElement('div');
    head.className = 'lse-detail-head';
    head.textContent = 'Per-size breakdown · ' + (data.lot_no || '')
      + (data.totalCut ? ' · total cut ' + fmt(data.totalCut) : '');
    wrap.appendChild(head);

    var table = document.createElement('table');
    table.className = 'lse-detail-table';
    table.innerHTML =
      '<thead><tr>'
      + '<th>Size</th>'
      + '<th>Cut</th>'
      + '<th>Stitched</th>'
      + '<th>Assembled</th>'
      + '<th>Washed</th>'
      + '<th>Wash-In</th>'
      + '<th>Finished</th>'
      + '<th>Dispatched</th>'
      + '</tr></thead>';
    var tbody = document.createElement('tbody');
    data.sizes.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (s.size_label || '') + '</td>'
        + '<td>' + fmt(s.cut) + '</td>'
        + '<td>' + fmt(s.stitched) + '</td>'
        + '<td>' + fmt(s.assembled) + '</td>'
        + '<td>' + fmt(s.washed) + '</td>'
        + '<td>' + fmt(s.washing_in) + '</td>'
        + '<td>' + fmt(s.finished) + '</td>'
        + '<td>' + fmt(s.dispatched) + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function countCols(tr) {
    var cells = tr.children;
    var n = 0;
    for (var i = 0; i < cells.length; i++) {
      var cs = parseInt(cells[i].getAttribute('colspan') || '1', 10);
      n += isNaN(cs) ? 1 : cs;
    }
    return n || 1;
  }

  function getOrCreateDetailRow(tr) {
    if (tr._lseDetailRow && tr._lseDetailRow.parentNode === tr.parentNode) {
      return tr._lseDetailRow;
    }
    var detail = document.createElement('tr');
    detail.className = 'lse-detail-row';
    detail.style.display = 'none';
    var td = document.createElement('td');
    td.colSpan = countCols(tr);
    detail.appendChild(td);
    tr.parentNode.insertBefore(detail, tr.nextSibling);
    tr._lseDetailRow = detail;
    return detail;
  }

  function setLoading(td) {
    td.innerHTML = '';
    var spin = document.createElement('span');
    spin.className = 'lse-spinner';
    var txt = document.createElement('span');
    txt.textContent = 'Loading size detail…';
    td.appendChild(spin);
    td.appendChild(txt);
  }

  function setError(td, msg) {
    td.innerHTML = '';
    var p = document.createElement('div');
    p.className = 'lse-empty';
    p.textContent = msg || 'Failed to load size detail.';
    td.appendChild(p);
  }

  function toggleRow(tr, btn) {
    var lotNo = tr.getAttribute('data-lot-no');
    if (!lotNo) return;

    var detail = getOrCreateDetailRow(tr);
    var td = detail.firstChild;
    td.colSpan = countCols(tr);
    var expanded = btn.getAttribute('aria-expanded') === 'true';

    if (expanded) {
      detail.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Show size breakdown');
      return;
    }

    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Hide size breakdown');
    detail.style.display = '';

    if (tr._lseCachedData !== undefined) {
      // Cached — render instantly.
      td.innerHTML = '';
      td.appendChild(renderDetail(tr._lseCachedData));
      return;
    }

    setLoading(td);
    fetch(ENDPOINT + '?lot_no=' + encodeURIComponent(lotNo), {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        tr._lseCachedData = data;
        td.innerHTML = '';
        td.appendChild(renderDetail(data));
      })
      .catch(function (err) {
        console.error('lot-size-expand fetch failed:', err);
        setError(td, 'No size detail available.');
      });
  }

  function onClick(e) {
    var btn = e.target.closest && e.target.closest('.lse-toggle');
    if (!btn) return;
    var tr = btn.closest('tr[data-lot-no]');
    if (!tr) return;
    e.preventDefault();
    e.stopPropagation();
    toggleRow(tr, btn);
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var btn = e.target.closest && e.target.closest('.lse-toggle');
    if (!btn) return;
    var tr = btn.closest('tr[data-lot-no]');
    if (!tr) return;
    e.preventDefault();
    toggleRow(tr, btn);
  }

  function init() {
    injectStyles();
    document.addEventListener('click', onClick, false);
    document.addEventListener('keydown', onKeyDown, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
