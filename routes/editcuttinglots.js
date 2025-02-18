const express = require('express');
const router = express.Router();
const multer  = require('multer');
const upload = multer(); // This will parse multipart/form-data
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * GET /operator/editcuttinglots
 * Renders the main page with cutting master selection.
 */
router.get('/editcuttinglots', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Retrieve all cutting masters (assumed role "cutting_manager")
    const [masters] = await pool.query(
      `SELECT id, username FROM users 
       WHERE role_id IN (SELECT id FROM roles WHERE name = 'cutting_manager')
       ORDER BY username`
    );
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
    const [countRows] = await pool.query(countQuery, countParams);
    const totalCount = countRows[0].total;
    const totalPages = Math.ceil(totalCount / limit);
    
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
    
    const [lots] = await pool.query(query, queryParams);
    
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
    // Fetch lot details (ensure the lot belongs to the selected manager)
    const [lotRows] = await pool.query(
      `SELECT l.id, l.lot_no, l.sku, l.fabric_type, l.remark, l.total_pieces, l.created_at, u.username AS created_by
       FROM cutting_lots l
       JOIN users u ON l.user_id = u.id
       WHERE l.id = ? AND l.user_id = ?`,
      [lotId, managerId]
    );
    if (!lotRows.length) return res.status(404).send('Lot not found.');
    const lot = lotRows[0];

    // Fetch sizes for the lot.
    const [sizes] = await pool.query(
      `SELECT id, size_label, pattern_count, total_pieces
       FROM cutting_lot_sizes
       WHERE cutting_lot_id = ?`,
       [lotId]
    );
    // Fetch rolls used for the lot.
    const [rolls] = await pool.query(
      `SELECT id, roll_no, layers, weight_used, total_pieces
       FROM cutting_lot_rolls
       WHERE cutting_lot_id = ?`,
       [lotId]
    );
    // Fetch stitching assignments for the lot.
    const [assignments] = await pool.query(
      `SELECT sa.id AS assignment_id, sa.assigned_on, u.username AS assigned_to, u.id AS assigned_to_user_id
       FROM stitching_assignments sa
       JOIN users u ON sa.user_id = u.id
       WHERE sa.cutting_lot_id = ?
       ORDER BY sa.assigned_on DESC`,
       [lotId]
    );
    // Fetch stitching users for the dropdown.
    const [stitchingUsers] = await pool.query(
      `SELECT id, username
       FROM users
       WHERE is_active = 1 AND role_id IN (SELECT id FROM roles WHERE name = 'stitching_master')
       ORDER BY username`
    );

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
                  ${sizes.map((size) => `
                    <div class="mb-3 border p-2 rounded">
                      <input type="hidden" name="size_id[]" value="${size.id}">
                      <div class="row">
                        <div class="col-md-4">
                          <label class="form-label">Size</label>
                          <input type="text" class="form-control" value="${size.size_label}" readonly>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Pattern Count</label>
                          <input type="number" step="0.01" class="form-control patternCountInput" name="pattern_count[]" value="${size.pattern_count}" required>
                        </div>
                        <div class="col-md-4">
                          <label class="form-label">Total Pieces (This Size)</label>
                          <input type="number" class="form-control sizeTotalPieces" value="${size.total_pieces}" readonly>
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
          // Recalculate total pieces dynamically.
          function recalcTotals() {
            const container = document.getElementById("editFormWrapper");
            const patternInputs = container.querySelectorAll(".patternCountInput");
            const layerInputs = container.querySelectorAll(".layersInput");
            let totalPatterns = 0, totalLayers = 0;
            patternInputs.forEach(input => {
              totalPatterns += parseFloat(input.value) || 0;
            });
            layerInputs.forEach(input => {
              totalLayers += parseFloat(input.value) || 0;
            });
            const totalPieces = totalPatterns * totalLayers;
            const totalDisplay = container.querySelector("#totalPiecesDisplay");
            if(totalDisplay) totalDisplay.textContent = totalPieces.toFixed(2);
            const sizeTotalFields = container.querySelectorAll(".sizeTotalPieces");
            patternInputs.forEach((input, idx) => {
              const pattern = parseFloat(input.value) || 0;
              if(sizeTotalFields[idx]) sizeTotalFields[idx].value = (pattern * totalLayers).toFixed(2);
            });
          }
          document.querySelectorAll(".patternCountInput, .layersInput").forEach(input => {
            input.addEventListener("input", recalcTotals);
          });
          recalcTotals();
          
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
  let { size_id, pattern_count } = req.body;
  if (!Array.isArray(size_id)) { size_id = [size_id]; pattern_count = [pattern_count]; }
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
    for (let i = 0; i < size_id.length; i++) {
      const newPattern = parseFloat(pattern_count[i]);
      if (isNaN(newPattern) || newPattern < 0) throw new Error('Invalid pattern count.');
      await conn.query(`UPDATE cutting_lot_sizes SET pattern_count = ? WHERE id = ?`, [newPattern, size_id[i]]);
    }
    for (let i = 0; i < roll_id.length; i++) {
      const newLayers = parseFloat(layers[i]);
      const newWeightUsed = parseFloat(weight_used[i]);
      if (isNaN(newLayers) || newLayers < 0 || isNaN(newWeightUsed) || newWeightUsed < 0) throw new Error('Invalid roll data.');
      const [rollRows] = await conn.query(`SELECT roll_no, weight_used FROM cutting_lot_rolls WHERE id = ?`, [roll_id[i]]);
      if (!rollRows.length) throw new Error('Roll entry not found.');
      const currentRoll = rollRows[0];
      const delta = newWeightUsed - parseFloat(currentRoll.weight_used);
      const [fiRows] = await conn.query(`SELECT per_roll_weight FROM fabric_invoice_rolls WHERE roll_no = ? FOR UPDATE`, [currentRoll.roll_no]);
      if (!fiRows.length) throw new Error(`Roll No. ${currentRoll.roll_no} not found in fabric_invoice_rolls.`);
      const availableWeight = parseFloat(fiRows[0].per_roll_weight);
      if (delta > 0 && delta > availableWeight) throw new Error(`Insufficient available weight for Roll No. ${currentRoll.roll_no}. Needed additional ${delta}, available ${availableWeight}.`);
      await conn.query(`UPDATE fabric_invoice_rolls SET per_roll_weight = per_roll_weight - ? WHERE roll_no = ?`, [delta, currentRoll.roll_no]);
      await conn.query(`UPDATE cutting_lot_rolls SET layers = ?, weight_used = ? WHERE id = ?`, [newLayers, newWeightUsed, roll_id[i]]);
    }
    for (let i = 0; i < assignment_id.length; i++) {
      const newAssignedTo = assigned_to[i];
      await conn.query(`UPDATE stitching_assignments SET user_id = ? WHERE id = ?`, [newAssignedTo, assignment_id[i]]);
    }
    const [rollSum] = await conn.query(`SELECT SUM(layers) AS total_layers FROM cutting_lot_rolls WHERE cutting_lot_id = ?`, [lotId]);
    const totalLayers = parseFloat(rollSum[0].total_layers) || 0;
    const [sizeSum] = await conn.query(`SELECT SUM(pattern_count) AS total_patterns FROM cutting_lot_sizes WHERE cutting_lot_id = ?`, [lotId]);
    const totalPatterns = parseFloat(sizeSum[0].total_patterns) || 0;
    const totalPieces = totalLayers * totalPatterns;
    await conn.query(`UPDATE cutting_lots SET total_pieces = ? WHERE id = ?`, [totalPieces, lotId]);
    await conn.query(`UPDATE cutting_lot_sizes SET total_pieces = pattern_count * ? WHERE cutting_lot_id = ?`, [totalLayers, lotId]);
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

module.exports = router;
