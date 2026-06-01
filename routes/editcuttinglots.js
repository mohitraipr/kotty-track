const express = require('express');
const router = express.Router();
const multer  = require('multer');
const upload = multer(); // This will parse multipart/form-data
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// simple in-memory cache for cutting masters
const masterCache = { data: null, expires: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Stages whose size breakdowns are keyed by the size_label STRING. Used by the
// cascade below. Fixed whitelist (never user input) so it's safe to interpolate
// into table names.
const SIZE_STAGES = ['stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing'];

/**
 * Rename a size label for ONE cutting lot across every place a piece breakdown
 * is tracked by the size_label string, so editing a cut size never desyncs
 * downstream. Covers BOTH the new event model (*_event_sizes) and the legacy
 * data model (*_data_sizes / *_data_updates), plus dispatches, rejects, rewash,
 * self-assignment sizes, production_flow_events, and the assignment sizes_json
 * blobs. Must run inside the caller's transaction (conn).
 *
 * Scope is the single lot (by cutting_lot_id for event/assignment tables, by
 * lot_no for the legacy data tables). oldLabel/newLabel are exact-match strings.
 */
async function cascadeSizeRename(conn, lotId, lotNo, oldLabel, newLabel) {
  // 1) New event model — *_event_sizes linked to the lot via *_events.cutting_lot_id
  for (const s of SIZE_STAGES) {
    await conn.query(
      `UPDATE ${s}_event_sizes es JOIN ${s}_events e ON es.event_id = e.id
          SET es.size_label = ?
        WHERE e.cutting_lot_id = ? AND es.size_label = ?`,
      [newLabel, lotId, oldLabel]
    );
  }
  // 2) Legacy data model — *_data_sizes / *_data_updates linked via *_data.lot_no
  for (const s of SIZE_STAGES) {
    await conn.query(
      `UPDATE ${s}_data_sizes x JOIN ${s}_data p ON x.${s}_data_id = p.id
          SET x.size_label = ?
        WHERE p.lot_no = ? AND x.size_label = ?`,
      [newLabel, lotNo, oldLabel]
    );
    await conn.query(
      `UPDATE ${s}_data_updates x JOIN ${s}_data p ON x.${s}_data_id = p.id
          SET x.size_label = ?
        WHERE p.lot_no = ? AND x.size_label = ?`,
      [newLabel, lotNo, oldLabel]
    );
  }
  // 3) Direct / other size_label-keyed tables for this lot
  await conn.query(
    `UPDATE finishing_dispatches SET size_label = ? WHERE lot_no = ? AND size_label = ?`,
    [newLabel, lotNo, oldLabel]
  );
  await conn.query(
    `UPDATE reject_data_sizes x JOIN reject_data r ON x.reject_data_id = r.id
        SET x.size_label = ? WHERE r.lot_no = ? AND x.size_label = ?`,
    [newLabel, lotNo, oldLabel]
  );
  await conn.query(
    `UPDATE rewash_request_sizes x JOIN rewash_requests r ON x.rewash_request_id = r.id
        SET x.size_label = ? WHERE r.lot_no = ? AND x.size_label = ?`,
    [newLabel, lotNo, oldLabel]
  );
  await conn.query(
    `UPDATE size_assignments x JOIN lot_assignments la ON x.lot_assignment_id = la.id
        SET x.size_label = ? WHERE la.cutting_lot_id = ? AND x.size_label = ?`,
    [newLabel, lotId, oldLabel]
  );
  await conn.query(
    `UPDATE production_flow_events SET size_label = ? WHERE lot_number = ? AND size_label = ?`,
    [newLabel, lotNo, oldLabel]
  );
  // 4) Assignment sizes_json blobs. Formats vary across tables
  //    ({"size":..}, {"size_label":..}, ["26",..]) but every label is a quoted
  //    token and no key/other value equals a label, so a single quoted-token
  //    REPLACE is correct for all of them.
  const from = '"' + oldLabel + '"';
  const to = '"' + newLabel + '"';
  const like = '%"' + oldLabel + '"%';
  await conn.query(
    `UPDATE stitching_assignments SET sizes_json = REPLACE(sizes_json, ?, ?)
      WHERE cutting_lot_id = ? AND sizes_json LIKE ?`,
    [from, to, lotId, like]
  );
  await conn.query(
    `UPDATE jeans_assembly_assignments ja
        JOIN stitching_assignments sa ON ja.stitching_assignment_id = sa.id
        SET ja.sizes_json = REPLACE(ja.sizes_json, ?, ?)
      WHERE sa.cutting_lot_id = ? AND ja.sizes_json LIKE ?`,
    [from, to, lotId, like]
  );
  await conn.query(
    `UPDATE washing_assignments wa
        JOIN jeans_assembly_assignments ja ON wa.jeans_assembly_assignment_id = ja.id
        JOIN stitching_assignments sa ON ja.stitching_assignment_id = sa.id
        SET wa.sizes_json = REPLACE(wa.sizes_json, ?, ?)
      WHERE sa.cutting_lot_id = ? AND wa.sizes_json LIKE ?`,
    [from, to, lotId, like]
  );
  await conn.query(
    `UPDATE washing_in_assignments wia
        JOIN washing_data wd ON wia.washing_data_id = wd.id
        SET wia.sizes_json = REPLACE(wia.sizes_json, ?, ?)
      WHERE wd.lot_no = ? AND wia.sizes_json LIKE ?`,
    [from, to, lotNo, like]
  );
  await conn.query(
    `UPDATE finishing_assignments fa
        JOIN washing_in_data wid ON fa.washing_in_data_id = wid.id
        SET fa.sizes_json = REPLACE(fa.sizes_json, ?, ?)
      WHERE wid.lot_no = ? AND fa.sizes_json LIKE ?`,
    [from, to, lotNo, like]
  );
}

/**
 * GET /operator/editcuttinglots
 * Renders the main page with cutting master selection.
 */
router.get('/editcuttinglots', isAuthenticated, isOperator, async (req, res) => {
  try {
    let masters = masterCache.data;
    if (!masters || masterCache.expires < Date.now()) {
      const [rows] = await pool.query(
        `SELECT id, username FROM users
         WHERE role_id IN (SELECT id FROM roles WHERE name = 'cutting_manager')
         ORDER BY username`
      );
      masters = rows;
      masterCache.data = masters;
      masterCache.expires = Date.now() + CACHE_TTL;
    }
    res.render('editcuttinglots', { user: req.session.user, masters });
  } catch (err) {
    console.error("Error in GET /operator/editcuttinglots:", err);
    req.flash('error', 'Failed to load edit cutting lots page.');
    res.redirect('/');
  }
});

/**
 * GET /operator/editcuttinglots/lot-list?managerId=...&page=...&search=...
 * Returns an HTML snippet (a table) of cutting lots for the specified cutting master.
 * Includes global search (across lot_no, sku, fabric_type, remark) and pagination.
 */
router.get('/editcuttinglots/lot-list', isAuthenticated, isOperator, async (req, res) => {
  const { managerId } = req.query;
  let page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const limit = 10;
  const offset = (page - 1) * limit;
  if (!managerId) return res.status(400).send('Manager ID is required.');
  try {
    // Build count query (for pagination)
    let countQuery = `SELECT COUNT(*) as total FROM cutting_lots WHERE user_id = ?`;
    let countParams = [managerId];
    let searchTerm = '';
    if (search && search.trim() !== '') {
      searchTerm = '%' + search.trim() + '%';
      countQuery += ` AND (lot_no LIKE ? OR sku LIKE ? OR fabric_type LIKE ? OR remark LIKE ?)`;
      countParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Build main query with search and pagination.
    let query = `SELECT id, lot_no, sku, fabric_type, remark, total_pieces, created_at
                 FROM cutting_lots
                 WHERE user_id = ? `;
    let queryParams = [managerId];
    if (search && search.trim() !== '') {
      query += ` AND (lot_no LIKE ? OR sku LIKE ? OR fabric_type LIKE ? OR remark LIKE ?) `;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);

    const [[countRows], [lots]] = await Promise.all([
      pool.query(countQuery, countParams),
      pool.query(query, queryParams)
    ]);
    const totalCount = countRows.total;
    const totalPages = Math.ceil(totalCount / limit);
    
    let html = `<div class="card">
      <div class="card-header"><h3>Cutting Lots</h3></div>
      <div class="card-body">
      <table class="table table-bordered">
        <thead>
          <tr>
            <th>Lot Number</th>
            <th>SKU</th>
            <th>Fabric Type</th>
            <th>Remark</th>
            <th>Total Pieces</th>
            <th>Created At</th>
            <th>Edit</th>
          </tr>
        </thead>
        <tbody>`;
    if (lots.length === 0) {
      html += '<tr><td colspan="7">No cutting lots found for this master.</td></tr>';
    } else {
      lots.forEach(lot => {
        html += `<tr data-lot-id="${lot.id}">
          <td>${lot.lot_no}</td>
          <td>${lot.sku}</td>
          <td>${lot.fabric_type}</td>
          <td>${lot.remark || ''}</td>
          <td>${lot.total_pieces}</td>
          <td>${new Date(lot.created_at).toLocaleString()}</td>
          <td><button class="btn btn-primary btn-sm edit-lot-btn" data-lot-id="${lot.id}">Edit</button></td>
        </tr>`;
      });
    }
    html += `</tbody></table>`;
    
    // Pagination controls.
    if (totalPages > 1) {
      html += `<nav aria-label="Page navigation"><ul class="pagination">`;
      for (let i = 1; i <= totalPages; i++) {
        html += `<li class="page-item ${i === page ? 'active' : ''}">
                   <a class="page-link pagination-link" href="#" data-page="${i}">${i}</a>
                 </li>`;
      }
      html += `</ul></nav>`;
    }
    
    html += `</div></div>`;
    res.send(html);
  } catch (err) {
    console.error("Error in GET /operator/editcuttinglots/lot-list:", err);
    res.status(500).send('Server error.');
  }
});

/**
 * GET /operator/editcuttinglots/edit-form?managerId=...&lotId=...
 * Returns an HTML snippet of the combined edit form for the selected lot.
 */
router.get('/editcuttinglots/edit-form', isAuthenticated, isOperator, async (req, res) => {
  const { managerId, lotId } = req.query;
  if (!managerId || !lotId) return res.status(400).send('Manager and Lot IDs are required.');
  try {
    const [[lotRows], [sizes], [rolls], [assignments], [stitchingUsers], [downstream]] = await Promise.all([
      pool.query(
        `SELECT l.id, l.lot_no, l.sku, l.fabric_type, l.remark, l.total_pieces, l.table_length, l.flow_type, l.created_at, u.username AS created_by
         FROM cutting_lots l
         JOIN users u ON l.user_id = u.id
         WHERE l.id = ? AND l.user_id = ?`,
        [lotId, managerId]
      ),
      pool.query(
        `SELECT id, size_label, pattern_count, total_pieces
         FROM cutting_lot_sizes
         WHERE cutting_lot_id = ?`,
        [lotId]
      ),
      pool.query(
        `SELECT id, roll_no, layers, weight_used, total_pieces
         FROM cutting_lot_rolls
         WHERE cutting_lot_id = ?`,
        [lotId]
      ),
      pool.query(
        `SELECT sa.id AS assignment_id, sa.assigned_on, u.username AS assigned_to, u.id AS assigned_to_user_id
         FROM stitching_assignments sa
         JOIN users u ON sa.user_id = u.id
         WHERE sa.cutting_lot_id = ?
         ORDER BY sa.assigned_on DESC`,
        [lotId]
      ),
      pool.query(
        `SELECT id, username
         FROM users
         WHERE is_active = 1 AND role_id IN (SELECT id FROM roles WHERE name = 'stitching_master')
         ORDER BY username`
      ),
      // Downstream events — used to surface a warning if the lot has
      // already moved past cutting. Adding a missed roll is still
      // allowed, but the user should know about pendency implications.
      pool.query(
        `SELECT 'stitching' AS stage, COUNT(*) c FROM stitching_events WHERE cutting_lot_id = ?
         UNION ALL SELECT 'assembly',  COUNT(*) FROM jeans_assembly_events WHERE cutting_lot_id = ?
         UNION ALL SELECT 'washing',   COUNT(*) FROM washing_events WHERE cutting_lot_id = ?
         UNION ALL SELECT 'washing_in',COUNT(*) FROM washing_in_events WHERE cutting_lot_id = ?
         UNION ALL SELECT 'finishing', COUNT(*) FROM finishing_events WHERE cutting_lot_id = ?`,
        [lotId, lotId, lotId, lotId, lotId]
      ),
    ]);

    if (!lotRows.length) return res.status(404).send('Lot not found.');
    const lot = lotRows[0];
    const isDenim = (lot.flow_type === 'denim');

    // Rolls available in inventory for this lot's fabric_type (for the autocomplete)
    const [availableRolls] = await pool.query(
      `SELECT fir.roll_no, fir.per_roll_weight, fir.unit
         FROM fabric_invoice_rolls fir
         JOIN fabric_invoices fi ON fi.id = fir.invoice_id
        WHERE fi.fabric_type = ? AND fir.per_roll_weight > 0
     ORDER BY fir.roll_no`,
      [lot.fabric_type]
    );

    // Has any downstream stage seen this lot?
    const downstreamHits = downstream.filter(d => d.c > 0).map(d => d.stage);

    // Build the combined edit form HTML.
    let html = `
      <div id="editFormWrapper">
        <div class="card">
          <div class="card-header"><h3>Edit Lot: ${lot.lot_no}</h3></div>
          <div class="card-body">
            <form id="updateLotForm" method="POST" action="/operator/editcuttinglots/update?managerId=${managerId}&lotId=${lot.id}">
              <!-- Nav Tabs -->
              <ul class="nav nav-tabs" id="editTabs" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab-details" type="button" role="tab">Lot Details</button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-sizes" type="button" role="tab">Sizes & Rolls</button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-assignment" type="button" role="tab">Stitching Assignment</button>
                </li>
              </ul>
              <div class="tab-content mt-3">
                <!-- Lot Details Tab -->
                <div class="tab-pane fade show active" id="tab-details" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Lot Number</label>
                    <input type="text" class="form-control" name="lot_no" value="${lot.lot_no}" readonly>
                  </div>
                  <div class="mb-3">
                    <label class="form-label">SKU</label>
                    <input type="text" class="form-control" name="sku" value="${lot.sku}" required>
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Fabric Type</label>
                    <input type="text" class="form-control" name="fabric_type" value="${lot.fabric_type}" required>
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Remark</label>
                    <textarea class="form-control" name="remark" rows="2">${lot.remark || ''}</textarea>
                  </div>
                  <div class="mb-3">
                    <strong>Total Pieces (Calculated): </strong>
                    <span id="totalPiecesDisplay">${lot.total_pieces}</span>
                  </div>
                </div>
                <!-- Sizes & Rolls Tab -->
                <div class="tab-pane fade" id="tab-sizes" role="tabpanel">
                  <h5>Sizes & Patterns</h5>
                  <p class="text-muted small mb-2">
                    You can rename a <strong>Size</strong> (e.g. fix a wrong/duplicate label) and set
                    <strong>Total Pieces</strong> per size directly. Total Pieces (lot) is the sum of all sizes below.
                  </p>
                  ${downstreamHits.length ? `
                    <div class="alert alert-warning py-2 mb-2 small">
                      <i class="bi bi-exclamation-triangle-fill"></i>
                      <strong>Heads-up:</strong> this lot has already moved into <strong>${downstreamHits.join(', ')}</strong>.
                      Renaming a size here will be <strong>cascaded</strong> to those stages so nothing desyncs.
                    </div>` : ''}
                  ${sizes.map((size) => `
                    <div class="mb-3 border p-2 rounded">
                      <input type="hidden" name="size_id[]" value="${size.id}">
                      <input type="hidden" name="orig_size_label[]" value="${size.size_label}">
                      <div class="row">
                        <div class="col-md-4">
                          <label class="form-label">Size</label>
                          <input type="text" maxlength="10" class="form-control sizeLabelInput" name="size_label[]" value="${size.size_label}" required>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Pattern Count</label>
                          <input type="number" step="0.01" class="form-control patternCountInput" name="pattern_count[]" value="${size.pattern_count}" required>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Total Pieces (This Size)</label>
                          <input type="number" step="1" min="0" class="form-control sizeTotalPieces" name="size_pieces[]" value="${size.total_pieces}" required>
                        </div>
                      </div>
                    </div>
                  `).join('')}
                  <h5 class="mt-3">Rolls Used</h5>
                  ${rolls.map((roll) => `
                    <div class="mb-3 border p-2 rounded">
                      <input type="hidden" name="roll_id[]" value="${roll.id}">
                      <div class="row">
                        <div class="col-md-4">
                          <label class="form-label">Roll Number</label>
                          <input type="text" class="form-control" name="roll_no[]" value="${roll.roll_no}" readonly>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Layers</label>
                          <input type="number" class="form-control layersInput" name="layers[]" value="${roll.layers}" required>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Weight Used</label>
                          <input type="number" step="0.01" class="form-control weightUsedInput" name="weight_used[]" value="${roll.weight_used}" required>
                        </div>
                      </div>
                    </div>
                  `).join('')}

                  <!-- ───── Add a missed roll ───── -->
                  <div class="mt-4 p-3 border rounded" style="background:#f8fafc;">
                    <h5 class="mb-2"><i class="bi bi-plus-circle"></i> Add a missed roll</h5>
                    <p class="text-muted small mb-2">
                      Inserts a new roll into this lot, recomputes total pieces, and (if the roll exists in inventory) deducts the used weight from <code>fabric_invoice_rolls</code>.
                      ${isDenim ? 'Weight Used is auto-computed from <strong>table_length × layers</strong>.' : 'Enter <strong>Remaining</strong>; Weight Used is derived automatically.'}
                    </p>
                    ${isDenim && !lot.table_length ? `
                      <div class="alert alert-danger py-2 mb-2 small">
                        This denim lot has no <strong>table_length</strong> — Weight Used can't be computed. Set table_length on the lot first.
                      </div>` : ''}
                    ${downstreamHits.length ? `
                      <div class="alert alert-warning py-2 mb-2 small">
                        <i class="bi bi-exclamation-triangle-fill"></i>
                        <strong>Heads-up:</strong> this lot has already moved into <strong>${downstreamHits.join(', ')}</strong>.
                        Adding pieces upstream is allowed (downstream stages track their own qty), but the next-stage master will see more pieces available than before.
                      </div>` : ''}
                    <div class="row g-2">
                      <div class="col-md-4">
                        <label class="form-label">Roll Number</label>
                        <input type="text" class="form-control" id="addRollNo" list="addRollNoOptions" placeholder="Pick or type roll #" autocomplete="off">
                        <datalist id="addRollNoOptions">
                          ${availableRolls.map(r => `<option value="${r.roll_no}" label="Avail ${r.per_roll_weight} ${r.unit || ''}"></option>`).join('')}
                        </datalist>
                        <div class="form-text" id="addRollAvail" style="font-size:0.75rem;color:#6b7280;"></div>
                      </div>
                      <div class="col-md-2">
                        <label class="form-label">Layers</label>
                        <input type="number" min="1" step="1" class="form-control" id="addRollLayers" placeholder="Layers">
                      </div>
                      <div class="col-md-2">
                        <label class="form-label">Full Weight</label>
                        <input type="number" step="0.01" min="0" class="form-control" id="addRollFullWeight" placeholder="Full">
                      </div>
                      <div class="col-md-2">
                        <label class="form-label">Weight Used</label>
                        <input type="number" step="0.01" min="0" class="form-control" id="addRollWeightUsed" readonly placeholder="Weight used (auto)">
                      </div>
                      <div class="col-md-2">
                        <label class="form-label">Remaining</label>
                        <input type="number" step="0.01" min="0" class="form-control" id="addRollRemaining" ${isDenim ? 'readonly' : 'value="0"'} placeholder="${isDenim ? 'Auto' : 'Remaining (default 0)'}">
                      </div>
                    </div>
                    <div id="addRollError" class="text-danger small mt-2" style="display:none;"></div>
                    <div class="mt-3">
                      <button type="button" class="btn btn-primary btn-sm" id="addRollBtn"${isDenim && !lot.table_length ? ' disabled' : ''}>
                        <i class="bi bi-plus-circle"></i> Add roll to lot
                      </button>
                    </div>
                  </div>
                </div>
                <!-- Stitching Assignment Tab -->
                <div class="tab-pane fade" id="tab-assignment" role="tabpanel">
                  <h5>Stitching Assignment</h5>
                  ${assignments.length === 0 
                    ? '<p>No stitching assignment found for this lot.</p>'
                    : `
                      <div class="table-responsive">
                        <table class="table table-bordered">
                          <thead>
                            <tr>
                              <th>Assigned To</th>
                              <th>Assigned On</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${assignments.map(assignment => `
                              <tr>
                                <td>
                                  <input type="hidden" name="assignment_id[]" value="${assignment.assignment_id}">
                                  <select name="assigned_to[]" class="form-select" required>
                                    ${stitchingUsers.map(user => `
                                      <option value="${user.id}" ${user.id == assignment.assigned_to_user_id ? 'selected' : ''}>${user.username}</option>
                                    `).join('')}
                                  </select>
                                </td>
                                <td>
                                  <input type="text" class="form-control" value="${new Date(assignment.assigned_on).toLocaleString()}" readonly>
                                </td>
                              </tr>
                            `).join('')}
                          </tbody>
                        </table>
                      </div>
                    `}
                </div>
              </div>
              <div class="mt-3">
                <button type="submit" class="btn btn-success">Update Lot</button>
              </div>
            </form>
          </div>
        </div>
        <script>
          // Lot total = sum of the (editable) per-size piece counts.
          function recalcTotals() {
            const container = document.getElementById("editFormWrapper");
            const sizeTotalFields = container.querySelectorAll(".sizeTotalPieces");
            let totalPieces = 0;
            sizeTotalFields.forEach(input => {
              totalPieces += parseFloat(input.value) || 0;
            });
            const totalDisplay = container.querySelector("#totalPiecesDisplay");
            if(totalDisplay) totalDisplay.textContent = totalPieces.toFixed(2);
          }
          document.querySelectorAll(".sizeTotalPieces").forEach(input => {
            input.addEventListener("input", recalcTotals);
          });
          recalcTotals();

          // ───── Add-missed-roll wiring ─────
          const ROLL_INVENTORY = ${JSON.stringify(availableRolls.map(r => ({ roll_no: r.roll_no, per_roll_weight: Number(r.per_roll_weight) || 0, unit: r.unit || '' })))};
          const IS_DENIM = ${isDenim ? 'true' : 'false'};
          const TABLE_LENGTH = ${Number.isFinite(Number(lot.table_length)) ? Number(lot.table_length) : 'null'};
          const addRollNo        = document.getElementById('addRollNo');
          const addRollLayers    = document.getElementById('addRollLayers');
          const addRollFullW     = document.getElementById('addRollFullWeight');
          const addRollUsed      = document.getElementById('addRollWeightUsed');
          const addRollRem       = document.getElementById('addRollRemaining');
          const addRollAvail     = document.getElementById('addRollAvail');
          const addRollErr       = document.getElementById('addRollError');
          const addRollBtn       = document.getElementById('addRollBtn');

          // Mirrors CuttingWeight.computeRollWeights() in public/js/cuttingWeight.js
          // (inlined here because this form is a server-rendered HTML fragment).
          function recomputeAddRollWeights() {
            const full = parseFloat(addRollFullW.value);
            if (IS_DENIM) {
              const layers = parseFloat(addRollLayers.value);
              if (isNaN(layers) || TABLE_LENGTH == null) { addRollUsed.value=''; addRollRem.value=''; return; }
              const used = TABLE_LENGTH * layers;
              addRollUsed.value = used.toFixed(2);
              addRollRem.value = isNaN(full) ? '' : Math.max(full - used, 0).toFixed(2);
              addRollUsed.classList.toggle('text-danger', !isNaN(full) && used > full);
            } else {
              const remaining = addRollRem.value === '' ? 0 : parseFloat(addRollRem.value);
              if (isNaN(full)) { addRollUsed.value=''; addRollUsed.classList.remove('text-danger'); return; }
              addRollUsed.value = Math.max(full - remaining, 0).toFixed(2);
              addRollUsed.classList.toggle('text-danger', remaining > full);
            }
          }
          addRollNo.addEventListener('change', () => {
            const inv = ROLL_INVENTORY.find(r => r.roll_no === addRollNo.value.trim());
            if (inv) {
              addRollFullW.value = inv.per_roll_weight.toFixed(2);
              addRollFullW.readOnly = true;
              addRollAvail.textContent = 'Available in inventory: ' + inv.per_roll_weight + ' ' + (inv.unit || '');
            } else {
              addRollFullW.readOnly = false;
              addRollAvail.textContent = 'New roll (manual entry — not in inventory)';
            }
            recomputeAddRollWeights();
          });
          addRollFullW.addEventListener('input', recomputeAddRollWeights);
          if (IS_DENIM) {
            addRollLayers.addEventListener('input', recomputeAddRollWeights);
          } else {
            addRollRem.addEventListener('input', recomputeAddRollWeights);
          }

          addRollBtn.addEventListener('click', async () => {
            addRollErr.style.display = 'none';
            const roll_no = (addRollNo.value || '').trim();
            const layers  = parseFloat(addRollLayers.value);
            const full_weight = parseFloat(addRollFullW.value);
            const weight_used = parseFloat(addRollUsed.value);
            if (!roll_no)            return showErr('Pick a roll number.');
            if (!(layers > 0))       return showErr('Layers must be greater than 0.');
            if (!(full_weight > 0))  return showErr('Full weight must be greater than 0.');
            if (!(weight_used >= 0)) return showErr('Enter a valid Weight Used (0 or more).');
            if (weight_used > full_weight) return showErr('Weight used (' + weight_used.toFixed(2) + ') cannot exceed full weight (' + full_weight.toFixed(2) + ').');

            addRollBtn.disabled = true;
            try {
              const fd = new FormData();
              fd.append('roll_no', roll_no);
              fd.append('layers', layers);
              fd.append('full_weight', full_weight);
              fd.append('weight_used', weight_used);
              const r = await fetch('/operator/editcuttinglots/add-roll?managerId=${managerId}&lotId=${lot.id}', { method: 'POST', body: fd });
              const data = await r.json();
              if (!data.success) return showErr(data.error || 'Failed to add roll.');
              alert('Roll added. Total pieces is now ' + data.total_pieces + '.');
              // Reload the edit form to reflect new state
              const ev = new Event('change');
              document.getElementById('masterSelect') && document.getElementById('masterSelect').dispatchEvent(ev);
            } catch (e) {
              showErr('Network error: ' + e.message);
            } finally {
              addRollBtn.disabled = false;
            }
            function showErr(m) { addRollErr.textContent = m; addRollErr.style.display = 'block'; addRollBtn.disabled = false; }
          });
          
          // Handle form submission via AJAX.
          document.getElementById("updateLotForm").addEventListener("submit", function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            // Debug: Log all form fields.
            for (let [key, value] of formData.entries()) {
              console.log("Form field:", key, value);
            }
            fetch("/operator/editcuttinglots/update?managerId=${managerId}&lotId=${lot.id}", {
              method: "POST",
              body: formData
            })
            .then(response => response.json())
            .then(data => {
              if(data.success){
                alert("Lot updated successfully.");
                // Collapse the accordion.
                document.getElementById("editFormWrapper").parentNode.parentNode.style.display = "none";
                // Optionally refresh the lot list.
                document.getElementById("masterSelect").dispatchEvent(new Event("change"));
              } else {
                alert("Update failed: " + data.error);
              }
            })
            .catch(err => {
              console.error("Error updating lot:", err);
              alert("An error occurred during update.");
            });
          });
        </script>
      </div>
    `;
    res.send(html);
  } catch (err) {
    console.error("Error in GET /operator/editcuttinglots/edit-form:", err);
    res.status(500).send("Server error.");
  }
});

/**
 * POST /operator/editcuttinglots/update?managerId=...&lotId=...
 * Processes the update for the cutting lot.
 * Note: We added the `upload.none()` middleware to correctly parse multipart/form-data.
 */
router.post('/editcuttinglots/update', isAuthenticated, isOperator, upload.none(), async (req, res) => {
  const { managerId, lotId } = req.query;
  if (!managerId || !lotId) return res.status(400).json({ success: false, error: 'Manager and Lot IDs required.' });
  const { sku, fabric_type, remark } = req.body;
  let { size_id, pattern_count, size_label, orig_size_label, size_pieces } = req.body;
  if (!Array.isArray(size_id)) {
    size_id = [size_id];
    pattern_count = [pattern_count];
    size_label = [size_label];
    orig_size_label = [orig_size_label];
    size_pieces = [size_pieces];
  }
  let { roll_id, layers, weight_used } = req.body;
  if (!Array.isArray(roll_id)) { roll_id = [roll_id]; layers = [layers]; weight_used = [weight_used]; }
  let { assignment_id, assigned_to } = req.body;
  if (assignment_id) { 
    if (!Array.isArray(assignment_id)) { 
      assignment_id = [assignment_id]; 
      assigned_to = [assigned_to]; 
    }
  } else { 
    assignment_id = []; 
    assigned_to = []; 
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE cutting_lots SET sku = ?, fabric_type = ?, remark = ? WHERE id = ?`,
      [sku, fabric_type, remark, lotId]
    );

    // Need the lot_no to cascade size renames into the legacy data tables.
    const [[lotRow]] = await conn.query(`SELECT lot_no FROM cutting_lots WHERE id = ? FOR UPDATE`, [lotId]);
    if (!lotRow) throw new Error('Lot not found.');
    const lotNo = lotRow.lot_no;

    // Validate the resulting labels: non-empty, within length, and unique within the lot
    // (no unique constraint exists on cutting_lot_sizes, but allowing two sizes to share
    // a label would make downstream cascades ambiguous).
    const newLabels = size_label.map(s => String(s == null ? '' : s).trim());
    if (newLabels.some(l => l === '')) throw new Error('Size label cannot be empty.');
    if (newLabels.some(l => l.length > 10)) throw new Error('Size label too long (max 10 characters).');
    const dupLabel = newLabels.find((l, i) => newLabels.indexOf(l) !== i);
    if (dupLabel) throw new Error(`Duplicate size label "${dupLabel}" — each size must be unique within the lot.`);

    let totalPieces = 0;
    for (let i = 0; i < size_id.length; i++) {
      const newPattern = parseFloat(pattern_count[i]);
      const newPieces = parseFloat(size_pieces[i]);
      const newLabel = newLabels[i];
      const oldLabel = String(orig_size_label[i] == null ? '' : orig_size_label[i]).trim();
      if (isNaN(newPattern) || newPattern < 0) throw new Error('Invalid pattern count.');
      if (isNaN(newPieces) || newPieces < 0) throw new Error(`Invalid total pieces for size "${newLabel}".`);
      totalPieces += newPieces;
      // Per-size pieces are now authoritative (set directly), no longer derived from pattern × layers.
      await conn.query(
        `UPDATE cutting_lot_sizes SET size_label = ?, pattern_count = ?, total_pieces = ? WHERE id = ? AND cutting_lot_id = ?`,
        [newLabel, newPattern, newPieces, size_id[i], lotId]
      );
      // Cascade a rename across every downstream stage so nothing desyncs by size_label.
      if (oldLabel && newLabel !== oldLabel) {
        await cascadeSizeRename(conn, lotId, lotNo, oldLabel, newLabel);
      }
    }

    const rollPlaceholders = roll_id.map(() => '?').join(',');
    const [rollInfo] = await conn.query(
      `SELECT r.id, r.roll_no, r.weight_used, r.layers, fi.per_roll_weight
         FROM cutting_lot_rolls r
         LEFT JOIN fabric_invoice_rolls fi ON r.roll_no = fi.roll_no
         WHERE r.id IN (${rollPlaceholders}) FOR UPDATE`,
      roll_id
    );
    const rollMap = new Map();
    rollInfo.forEach(r => rollMap.set(r.id, r));

    let totalLayers = 0;
    for (let i = 0; i < roll_id.length; i++) {
      const id = parseInt(roll_id[i]);
      const record = rollMap.get(id);
      if (!record) throw new Error('Roll entry not found.');
      const newLayers = parseFloat(layers[i]);
      const newWeightUsed = parseFloat(weight_used[i]);
      if (isNaN(newLayers) || newLayers < 0 || isNaN(newWeightUsed) || newWeightUsed < 0) {
        throw new Error('Invalid roll data.');
      }
      const delta = newWeightUsed - parseFloat(record.weight_used);
      const availableWeight = record.per_roll_weight === null ? null : parseFloat(record.per_roll_weight);
      if (availableWeight !== null) {
        if (delta > 0 && delta > availableWeight) {
          throw new Error(`Insufficient available weight for Roll No. ${record.roll_no}. Needed additional ${delta}, available ${availableWeight}.`);
        }
        await conn.query(`UPDATE fabric_invoice_rolls SET per_roll_weight = per_roll_weight - ? WHERE roll_no = ?`, [delta, record.roll_no]);
      }
      await conn.query(`UPDATE cutting_lot_rolls SET layers = ?, weight_used = ? WHERE id = ?`, [newLayers, newWeightUsed, id]);
      totalLayers += newLayers;
    }

    for (let i = 0; i < assignment_id.length; i++) {
      const newAssignedTo = assigned_to[i];
      await conn.query(`UPDATE stitching_assignments SET user_id = ? WHERE id = ?`, [newAssignedTo, assignment_id[i]]);
    }

    // Lot total is the sum of the (now authoritative) per-size piece counts.
    await conn.query(`UPDATE cutting_lots SET total_pieces = ? WHERE id = ?`, [totalPieces, lotId]);

    await conn.commit();
    conn.release();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error("Error in POST /operator/editcuttinglots/update:", err);
    res.json({ success: false, error: err.message || 'Update failed.' });
  }
});

/**
 * POST /operator/editcuttinglots/add-roll?managerId=…&lotId=…
 * Adds a missed roll to an existing cutting lot. Mirrors the
 * create-lot insert logic for one roll:
 *   - inserts cutting_lot_rolls
 *   - if roll is in inventory, deplete fabric_invoice_rolls
 *   - recomputes cutting_lots.total_pieces + all cutting_lot_sizes.total_pieces
 * Safe to call even if the lot has moved downstream — downstream
 * stages track their own pieces via *_events / sizes_json.
 */
router.post('/editcuttinglots/add-roll', isAuthenticated, isOperator, upload.none(), async (req, res) => {
  const { managerId, lotId } = req.query;
  if (!managerId || !lotId) {
    return res.status(400).json({ success: false, error: 'Manager and Lot IDs required.' });
  }
  const roll_no     = (req.body.roll_no || '').trim();
  const layers      = parseFloat(req.body.layers);
  const full_weight = parseFloat(req.body.full_weight);
  const weight_used = parseFloat(req.body.weight_used);

  if (!roll_no) return res.json({ success: false, error: 'Roll number is required.' });
  if (!(layers > 0)) return res.json({ success: false, error: 'Layers must be > 0.' });
  if (!(full_weight > 0)) return res.json({ success: false, error: 'Full weight must be > 0.' });
  if (!(weight_used >= 0)) return res.json({ success: false, error: 'Weight used must be ≥ 0.' });
  if (weight_used > full_weight) return res.json({ success: false, error: 'Weight used cannot exceed full weight.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Confirm the lot belongs to this manager + load fabric_type
    const [[lot]] = await conn.query(
      `SELECT id, fabric_type, table_length FROM cutting_lots WHERE id = ? AND user_id = ? FOR UPDATE`,
      [lotId, managerId]
    );
    if (!lot) throw new Error('Lot not found for this manager.');

    // Duplicate guard — don't insert the same roll twice into one lot
    const [[dup]] = await conn.query(
      `SELECT id FROM cutting_lot_rolls WHERE cutting_lot_id = ? AND roll_no = ? LIMIT 1`,
      [lotId, roll_no]
    );
    if (dup) throw new Error('This roll number is already in this lot.');

    // Inventory check — deplete fabric_invoice_rolls if the roll exists there
    const [[inv]] = await conn.query(
      `SELECT fir.roll_no, fir.per_roll_weight
         FROM fabric_invoice_rolls fir
         JOIN fabric_invoices fi ON fi.id = fir.invoice_id
        WHERE fir.roll_no = ? AND fi.fabric_type = ?
        FOR UPDATE`,
      [roll_no, lot.fabric_type]
    );
    let resolvedFullWeight = full_weight;
    if (inv) {
      resolvedFullWeight = parseFloat(inv.per_roll_weight);
      if (weight_used > resolvedFullWeight) {
        throw new Error(`Weight used (${weight_used}) exceeds inventory available (${resolvedFullWeight}) for roll ${roll_no}.`);
      }
      const [upd] = await conn.query(
        `UPDATE fabric_invoice_rolls SET per_roll_weight = per_roll_weight - ?
          WHERE roll_no = ? AND per_roll_weight >= ?`,
        [weight_used, roll_no, weight_used]
      );
      if (upd.affectedRows === 0) {
        throw new Error(`Insufficient inventory for roll ${roll_no}.`);
      }
    }
    const remaining_weight = Math.max(resolvedFullWeight - weight_used, 0);

    // Per-roll total_pieces = layers × Σ(pattern_count) for this lot
    const [[patternsRow]] = await conn.query(
      `SELECT COALESCE(SUM(pattern_count), 0) AS sum_patterns FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
      [lotId]
    );
    const sumPatterns = Number(patternsRow.sum_patterns) || 0;
    const newRollPieces = layers * sumPatterns;

    await conn.query(
      `INSERT INTO cutting_lot_rolls
         (cutting_lot_id, roll_no, weight_used, layers, total_pieces, full_weight, remaining_weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [lotId, roll_no, weight_used, layers, newRollPieces, resolvedFullWeight, remaining_weight]
    );

    // Increment each size by this roll's contribution (pattern_count × new layers),
    // preserving any manual per-size piece overrides made on the edit form. Then the
    // lot total is the sum of the per-size pieces.
    await conn.query(
      `UPDATE cutting_lot_sizes SET total_pieces = total_pieces + (pattern_count * ?) WHERE cutting_lot_id = ?`,
      [layers, lotId]
    );
    const [[sizeSumRow]] = await conn.query(
      `SELECT COALESCE(SUM(total_pieces), 0) AS sum_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
      [lotId]
    );
    const newLotPieces = Number(sizeSumRow.sum_pieces) || 0;
    await conn.query(`UPDATE cutting_lots SET total_pieces = ? WHERE id = ?`, [newLotPieces, lotId]);
    const [[layersRow]] = await conn.query(
      `SELECT COALESCE(SUM(layers), 0) AS sum_layers FROM cutting_lot_rolls WHERE cutting_lot_id = ?`,
      [lotId]
    );
    const sumLayers = Number(layersRow.sum_layers) || 0;

    await conn.commit();
    res.json({
      success: true,
      total_pieces: newLotPieces,
      sum_layers: sumLayers,
      sum_patterns: sumPatterns,
      roll_pieces: newRollPieces,
      inventory_depleted: !!inv,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Error in POST /operator/editcuttinglots/add-roll:', err);
    res.json({ success: false, error: err.message || 'Failed to add roll.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
