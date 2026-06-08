// routes/taskRoutes.js
//
// Personal to-dos + (Phase 2) user task assignment. Mounted at /tasks.
// Scoped to the `mohitteam` role only. The page (GET /tasks) renders an EJS
// shell that mounts a Vite/React/shadcn island; the island talks to the JSON
// API under /tasks/api/*. All list filters are derived from the session user —
// the client never supplies a user id to filter by.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const { taskAssetTags } = require('../utils/viteManifest');
const {
  isValidStatus,
  isValidPriority,
  classifyTask,
  canTransition,
} = require('../utils/taskLogic');

// Gate every route: must be logged in AND hold the mohitteam role.
// allowRoles returns JSON 403 when the client sends Accept: application/json.
const gate = [isAuthenticated, allowRoles(['mohitteam'])];

function isAdminUser(user) {
  return (user.roleName || user.role) === 'admin';
}

// SELECT columns shared by list + single-row reads. JOINs expose usernames so the
// UI can label creator/assignee (needed in Phase 2; harmless for personal todos).
// due_date is formatted to a plain 'YYYY-MM-DD' string so it doesn't drift a day
// when mysql2 returns a DATE as a Date object and JSON serializes it to UTC.
const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         DATE_FORMAT(t.due_date, '%Y-%m-%d') AS due_date,
         t.created_by, t.assigned_to, t.created_at, t.updated_at, t.completed_at,
         cu.username AS created_by_username,
         au.username AS assigned_to_username
  FROM user_tasks t
  JOIN users cu ON cu.id = t.created_by
  JOIN users au ON au.id = t.assigned_to`;

async function fetchTaskById(conn, id) {
  const [rows] = await conn.query(`${TASK_SELECT} WHERE t.id = ?`, [id]);
  return rows[0] || null;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Normalize a due_date input ('YYYY-MM-DD' or empty) to a value or null.
function normalizeDueDate(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// A task may only be assigned to an active mohitteam member (primary role OR a
// user_roles grant). Returns the username if assignable, else null.
async function assignableUsername(userId) {
  const [rows] = await pool.query(
    `SELECT u.username
       FROM users u
       LEFT JOIN roles r  ON r.id  = u.role_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r2 ON r2.id = ur.role_id
      WHERE u.id = ? AND u.is_active = TRUE
        AND (r.name = 'mohitteam' OR r2.name = 'mohitteam')
      LIMIT 1`,
    [userId]
  );
  return rows.length ? rows[0].username : null;
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------
router.get('/', gate, (req, res) => {
  try {
    const { jsTag, cssTags } = taskAssetTags();
    res.render('tasks', {
      user: req.session.user,
      req,
      pageTitle: 'Tasks',
      jsTag,
      cssTags,
    });
  } catch (err) {
    console.error('Error GET /tasks (island not built?):', err.message);
    res
      .status(500)
      .send('Tasks UI is not built yet. Run the frontend build: `cd frontend && npm install && npm run build`.');
  }
});

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

// List tasks for the current user, filtered by view.
//   view=mine             -> personal todos (created_by == assigned_to == me)
//   view=assigned_to_me   -> others assigned me (assigned_to == me, created_by != me)
//   view=assigned_by_me   -> I assigned to others (created_by == me, assigned_to != me)
router.get('/api/tasks', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    const view = req.query.view || 'mine';

    let where;
    if (view === 'assigned_to_me') {
      where = 'WHERE t.assigned_to = ? AND t.created_by <> ?';
    } else if (view === 'assigned_by_me') {
      where = 'WHERE t.created_by = ? AND t.assigned_to <> ?';
    } else {
      where = 'WHERE t.assigned_to = ? AND t.created_by = ?'; // mine
    }

    const [rows] = await pool.query(
      `${TASK_SELECT} ${where}
       ORDER BY FIELD(t.status,'in_progress','open','done','cancelled'),
                (t.due_date IS NULL), t.due_date ASC,
                FIELD(t.priority,'high','medium','low'),
                t.created_at DESC`,
      [me, me]
    );

    res.json({ tasks: rows });
  } catch (err) {
    console.error('Error GET /tasks/api/tasks:', err);
    res.status(500).json({ error: 'Failed to load tasks.' });
  }
});

// Create a task. Self-assigned by default (a personal to-do); an `assigned_to`
// of another active mohitteam member delegates it.
router.post('/api/tasks', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim() || null;
    const priority = isValidPriority(req.body.priority) ? req.body.priority : 'medium';
    const dueDate = normalizeDueDate(req.body.due_date);

    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (title.length > 255) return res.status(400).json({ error: 'Title is too long (max 255).' });

    // Resolve the assignee: default self; if delegating, must be a mohitteam member.
    let assignedTo = me;
    if (req.body.assigned_to !== undefined && req.body.assigned_to !== null && req.body.assigned_to !== '') {
      const candidate = parseId(req.body.assigned_to);
      if (!candidate) return res.status(400).json({ error: 'Invalid assignee.' });
      if (candidate !== me) {
        if (!(await assignableUsername(candidate))) {
          return res.status(400).json({ error: 'Assignee must be an active mohitteam member.' });
        }
        assignedTo = candidate;
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO user_tasks (title, description, status, priority, due_date, created_by, assigned_to)
         VALUES (?, ?, 'open', ?, ?, ?, ?)`,
        [title, description, priority, dueDate, me, assignedTo]
      );
      // Creation row in history: previous_status NULL -> 'open'.
      await conn.query(
        `INSERT INTO user_task_history (task_id, changed_by, previous_status, new_status)
         VALUES (?, ?, NULL, 'open')`,
        [result.insertId, me]
      );
      const task = await fetchTaskById(conn, result.insertId);
      await conn.commit();
      res.status(201).json({ task });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error POST /tasks/api/tasks:', err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
});

// Edit task fields (title/description/priority/due_date). Creator/admin only.
router.patch('/api/tasks/:id', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);

    const [rows] = await pool.query('SELECT created_by, assigned_to FROM user_tasks WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found.' });

    const caps = classifyTask(rows[0], me, isAdmin);
    if (!caps.canEditFields) return res.status(403).json({ error: 'You cannot edit this task.' });

    const title = req.body.title !== undefined ? (req.body.title || '').trim() : undefined;
    if (title !== undefined && !title) return res.status(400).json({ error: 'Title cannot be empty.' });
    if (title !== undefined && title.length > 255) return res.status(400).json({ error: 'Title is too long.' });

    const updates = [];
    const params = [];
    if (title !== undefined) { updates.push('title = ?'); params.push(title); }
    if (req.body.description !== undefined) {
      updates.push('description = ?');
      params.push((req.body.description || '').trim() || null);
    }
    if (req.body.priority !== undefined) {
      if (!isValidPriority(req.body.priority)) return res.status(400).json({ error: 'Invalid priority.' });
      updates.push('priority = ?'); params.push(req.body.priority);
    }
    if (req.body.due_date !== undefined) {
      updates.push('due_date = ?'); params.push(normalizeDueDate(req.body.due_date));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(id);
    await pool.query(`UPDATE user_tasks SET ${updates.join(', ')} WHERE id = ?`, params);

    const [updated] = await pool.query(`${TASK_SELECT} WHERE t.id = ?`, [id]);
    res.json({ task: updated[0] });
  } catch (err) {
    console.error('Error PATCH /tasks/api/tasks/:id:', err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

// Transition status. Server validates the move; never trusts the client.
router.patch('/api/tasks/:id/status', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });

  const to = req.body.status;
  if (!isValidStatus(to)) return res.status(400).json({ error: 'Invalid status.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        'SELECT id, status, created_by, assigned_to FROM user_tasks WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({ error: 'Task not found.' });
      }

      const current = rows[0];
      const caps = classifyTask(current, me, isAdmin);
      if (!canTransition(current.status, to, caps)) {
        await conn.rollback();
        return res.status(403).json({ error: `Cannot change status from ${current.status} to ${to}.` });
      }

      await conn.query(
        `UPDATE user_tasks
            SET status = ?, completed_at = ${to === 'done' ? 'NOW()' : 'NULL'}
          WHERE id = ?`,
        [to, id]
      );
      await conn.query(
        `INSERT INTO user_task_history (task_id, changed_by, previous_status, new_status)
         VALUES (?, ?, ?, ?)`,
        [id, me, current.status, to]
      );
      const task = await fetchTaskById(conn, id);
      await conn.commit();
      res.json({ task });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error PATCH /tasks/api/tasks/:id/status:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// Delete a task. Creator/admin only. Removes history rows first (no FK cascade).
router.delete('/api/tasks/:id', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);

    const [rows] = await pool.query('SELECT created_by, assigned_to FROM user_tasks WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found.' });

    const caps = classifyTask(rows[0], me, isAdmin);
    if (!caps.canDelete) return res.status(403).json({ error: 'You cannot delete this task.' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_task_history WHERE task_id = ?', [id]);
      await conn.query('DELETE FROM user_tasks WHERE id = ?', [id]);
      await conn.commit();
      res.json({ ok: true });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error DELETE /tasks/api/tasks/:id:', err);
    res.status(500).json({ error: 'Failed to delete task.' });
  }
});

// Reassign a task to another mohitteam member. Creator/admin only.
router.patch('/api/tasks/:id/assign', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });

  const newAssignee = parseId(req.body.assigned_to);
  if (!newAssignee) return res.status(400).json({ error: 'Invalid assignee.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);

    const [rows] = await pool.query(
      'SELECT status, created_by, assigned_to FROM user_tasks WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found.' });

    const caps = classifyTask(rows[0], me, isAdmin);
    if (!caps.canReassign) return res.status(403).json({ error: 'You cannot reassign this task.' });

    const username = await assignableUsername(newAssignee);
    if (!username) return res.status(400).json({ error: 'Assignee must be an active mohitteam member.' });

    if (Number(rows[0].assigned_to) === newAssignee) {
      return res.status(400).json({ error: 'Task is already assigned to that user.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE user_tasks SET assigned_to = ? WHERE id = ?', [newAssignee, id]);
      // Log reassignment as a note row (status unchanged).
      await conn.query(
        `INSERT INTO user_task_history (task_id, changed_by, previous_status, new_status, note)
         VALUES (?, ?, ?, ?, ?)`,
        [id, me, rows[0].status, rows[0].status, `Reassigned to ${username}`]
      );
      const task = await fetchTaskById(conn, id);
      await conn.commit();
      res.json({ task });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error PATCH /tasks/api/tasks/:id/assign:', err);
    res.status(500).json({ error: 'Failed to reassign task.' });
  }
});

// History timeline for a task. Visible to its creator, assignee, or an admin.
router.get('/api/tasks/:id/history', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);

    const [taskRows] = await pool.query('SELECT created_by, assigned_to FROM user_tasks WHERE id = ?', [id]);
    if (!taskRows.length) return res.status(404).json({ error: 'Task not found.' });

    const caps = classifyTask(taskRows[0], me, isAdmin);
    if (!caps.isCreator && !caps.isAssignee && !isAdmin) {
      return res.status(403).json({ error: 'You cannot view this task.' });
    }

    const [history] = await pool.query(
      `SELECT h.id, h.previous_status, h.new_status, h.note,
              DATE_FORMAT(h.changed_at, '%Y-%m-%d %H:%i') AS changed_at,
              u.username AS changed_by_username
         FROM user_task_history h
         JOIN users u ON u.id = h.changed_by
        WHERE h.task_id = ?
        ORDER BY h.changed_at ASC, h.id ASC`,
      [id]
    );
    res.json({ history });
  } catch (err) {
    console.error('Error GET /tasks/api/tasks/:id/history:', err);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

// User picker: active mohitteam members, for the "assign to" field. Optional search.
router.get('/api/users', gate, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const [users] = await pool.query(
      `SELECT DISTINCT u.id, u.username
         FROM users u
         LEFT JOIN roles r  ON r.id  = u.role_id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r2 ON r2.id = ur.role_id
        WHERE u.is_active = TRUE
          AND (r.name = 'mohitteam' OR r2.name = 'mohitteam')
          AND (? = '' OR u.username LIKE CONCAT('%', ?, '%'))
        ORDER BY u.username
        LIMIT 100`,
      [search, search]
    );
    res.json({ users });
  } catch (err) {
    console.error('Error GET /tasks/api/users:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

module.exports = router;
