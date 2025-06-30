const { pool } = require('../config/db');

async function validateAttendanceFilename(filename) {
  const base = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
  const parts = base.split('_');
  if (parts.length !== 3 || !/^[0-9]+$/.test(parts[2])) {
    return { valid: false, message: 'Filename must follow departmentname_supervisorusername_supervisoruserid' };
  }
  const [deptName, username, idStr] = parts;
  const supervisorId = parseInt(idStr, 10);
  try {
    const [[dept]] = await pool.query('SELECT id FROM departments WHERE name = ? LIMIT 1', [deptName]);
    if (!dept) {
      return { valid: false, message: 'Invalid department in filename' };
    }
    const [[user]] = await pool.query('SELECT id FROM users WHERE id = ? AND username = ? LIMIT 1', [supervisorId, username]);
    if (!user) {
      return { valid: false, message: 'Invalid supervisor in filename' };
    }
    const [dsRows] = await pool.query(
      'SELECT 1 FROM department_supervisors WHERE department_id = ? AND user_id = ? LIMIT 1',
      [dept.id, supervisorId]
    );
    if (!dsRows.length) {
      return { valid: false, message: 'Supervisor not assigned to department' };
    }
    return { valid: true, departmentId: dept.id, supervisorId };
  } catch (err) {
    console.error('Filename validation error:', err);
    return { valid: false, message: 'Error validating filename' };
  }
}

module.exports = { validateAttendanceFilename };
