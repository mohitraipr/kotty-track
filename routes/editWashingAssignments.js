const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// GET /operator/editwashingassignments
router.get('/editwashingassignments', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [washers] = await pool.query(`
      SELECT u.id, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'washing'
         AND u.is_active = 1
       ORDER BY u.username
    `);
    res.render('editWashingAssignments', { user: req.session.user, washers });
  } catch (err) {
    console.error('Error in GET /operator/editwashingassignments:', err);
    req.flash('error', 'Failed to load edit washing assignments page.');
    res.redirect('/');
  }
});

// GET /operator/editwashingassignments/assignment-list?washerId=...
router.get('/editwashingassignments/assignment-list', isAuthenticated, isOperator, async (req, res) => {
  const { washerId } = req.query;
  if (!washerId) return res.status(400).send('Washer ID is required.');
  try {
    const [rows] = await pool.query(`
      SELECT wa.id AS assignment_id,
             jd.lot_no,
             jd.sku,
             wa.assigned_on,
             wa.is_approved
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       WHERE wa.user_id = ?
       ORDER BY wa.assigned_on DESC
    `, [washerId]);

    let html = `<div class="card"><div class="card-header"><h3>Assignments</h3></div><div class="card-body"><table class="table table-bordered"><thead><tr><th>Lot No</th><th>SKU</th><th>Assigned On</th><th>Status</th><th>Edit</th></tr></thead><tbody>`;
    if (!rows.length) {
      html += '<tr><td colspan="5">No assignments found for this washer.</td></tr>';
    } else {
      rows.forEach(a => {
        const status = a.is_approved === null ? 'Pending' : (a.is_approved ? 'Approved' : 'Denied');
        html += `<tr data-assignment-id="${a.assignment_id}">` +
                `<td>${a.lot_no}</td>` +
                `<td>${a.sku}</td>` +
                `<td>${new Date(a.assigned_on).toLocaleString()}</td>` +
                `<td>${status}</td>` +
                `<td><button class="btn btn-primary btn-sm edit-assignment-btn" data-assignment-id="${a.assignment_id}">Edit</button></td>` +
                `</tr>`;
      });
    }
    html += `</tbody></table></div></div>`;
    res.send(html);
  } catch (err) {
    console.error('Error in GET /operator/editwashingassignments/assignment-list:', err);
    res.status(500).send('Server error.');
  }
});

// GET /operator/editwashingassignments/edit-form?washerId=...&assignmentId=...
router.get('/editwashingassignments/edit-form', isAuthenticated, isOperator, async (req, res) => {
  const { washerId, assignmentId } = req.query;
  if (!washerId || !assignmentId) return res.status(400).send('IDs required.');
  try {
    const [[assignment]] = await pool.query(`
      SELECT wa.id, wa.user_id, jd.lot_no, jd.sku
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       WHERE wa.id = ? AND wa.user_id = ?
    `, [assignmentId, washerId]);
    if (!assignment) return res.status(404).send('Assignment not found.');

    const [washers] = await pool.query(`
      SELECT u.id, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'washing'
         AND u.is_active = 1
       ORDER BY u.username
    `);

    let html = `<form id="updateAssignmentForm">` +
               `<div class="mb-3">` +
               `<label class="form-label">Lot</label>` +
               `<input type="text" class="form-control" value="${assignment.lot_no}" readonly>` +
               `</div>` +
               `<div class="mb-3">` +
               `<label class="form-label">SKU</label>` +
               `<input type="text" class="form-control" value="${assignment.sku}" readonly>` +
               `</div>` +
               `<div class="mb-3">` +
               `<label class="form-label">Washer</label>` +
               `<select name="washer_id" class="form-select">` +
               washers.map(w => `<option value="${w.id}" ${w.id == assignment.user_id ? 'selected' : ''}>${w.username}</option>`).join('') +
               `</select>` +
               `</div>` +
               `<input type="hidden" name="assignment_id" value="${assignment.id}">` +
               `<button type="submit" class="btn btn-success">Update</button>` +
               `</form>`;
    res.send(html);
  } catch (err) {
    console.error('Error in GET /operator/editwashingassignments/edit-form:', err);
    res.status(500).send('Server error.');
  }
});

// POST /operator/editwashingassignments/update
router.post('/editwashingassignments/update', isAuthenticated, isOperator, upload.none(), async (req, res) => {
  const { assignment_id, washer_id } = req.body;
  if (!assignment_id || !washer_id) return res.json({ success: false, error: 'Missing parameters.' });
  try {
    await pool.query(`UPDATE washing_assignments SET user_id = ? WHERE id = ?`, [washer_id, assignment_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error in POST /operator/editwashingassignments/update:', err);
    res.json({ success: false, error: err.message || 'Update failed.' });
  }
});

module.exports = router;
