// routes/taskRoutes.js
//
// Tasks v2 (Linear-like). Mounted at /tasks, scoped to the `mohitteam` role.
// GET /tasks renders a full-screen React/shadcn island; the island talks to the
// JSON API under /tasks/api/*. Model: status (todo/in_progress/done/blocked),
// priority (none..urgent), single assignee, optional project, free-form tags.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const { taskAssetTags } = require('../utils/viteManifest');
const {
  isValidStatus,
  isValidPriority,
  classifyTask,
  canSetStatus,
} = require('../utils/taskLogic');

const gate = [isAuthenticated, allowRoles(['mohitteam'])];

function isAdminUser(user) {
  return (user.roleName || user.role) === 'admin';
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeDueDate(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Up to 12 tags, trimmed, <=50 chars, de-duped (case-insensitive).
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const tag = String(raw || '').trim().slice(0, 50);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

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

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         DATE_FORMAT(t.due_date, '%Y-%m-%d') AS due_date,
         t.created_by, t.assigned_to, t.project_id,
         t.created_at, t.updated_at, t.completed_at,
         cu.username AS created_by_username,
         au.username AS assigned_to_username,
         p.name AS project_name, p.project_key AS project_key, p.color AS project_color
  FROM user_tasks t
  JOIN users cu ON cu.id = t.created_by
  JOIN users au ON au.id = t.assigned_to
  LEFT JOIN task_projects p ON p.id = t.project_id`;

// Attach a `tags` array to each row (one extra round trip).
async function attachTags(conn, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const [tagRows] = await conn.query(
    `SELECT task_id, tag FROM user_task_tags WHERE task_id IN (?) ORDER BY tag`,
    [ids]
  );
  const byTask = {};
  for (const tr of tagRows) (byTask[tr.task_id] ||= []).push(tr.tag);
  for (const r of rows) r.tags = byTask[r.id] || [];
  return rows;
}

async function fetchTaskById(conn, id) {
  const [rows] = await conn.query(`${TASK_SELECT} WHERE t.id = ?`, [id]);
  if (!rows.length) return null;
  await attachTags(conn, rows);
  return rows[0];
}

// Replace a task's tags inside an open transaction.
async function setTags(conn, taskId, tags) {
  await conn.query('DELETE FROM user_task_tags WHERE task_id = ?', [taskId]);
  if (tags.length) {
    await conn.query(
      'INSERT INTO user_task_tags (task_id, tag) VALUES ?',
      [tags.map((t) => [taskId, t])]
    );
  }
}

// ---------------------------------------------------------------------------
// Page shell (full-screen island)
// ---------------------------------------------------------------------------
router.get('/', gate, (req, res) => {
  try {
    const { jsTag, cssTags } = taskAssetTags();
    res.render('tasks', { user: req.session.user, jsTag, cssTags });
  } catch (err) {
    console.error('Error GET /tasks (island not built?):', err.message);
    res.status(500).send('Tasks UI is not built yet. Run: cd frontend && npm install && npm run build');
  }
});

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

// List tasks the current user is involved in (creator OR assignee) — a user
// NEVER sees other people's personal tasks. view=all = everything I'm involved
// in; view=mine = assigned to me. Optional project_id.
router.get('/api/tasks', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    const view = req.query.view === 'mine' ? 'mine' : 'all';
    const projectId = req.query.project_id ? parseId(req.query.project_id) : null;

    const where = [];
    const params = [];
    if (view === 'mine') {
      where.push('t.assigned_to = ?');
      params.push(me);
    } else {
      // Visibility rule: only tasks I created or that are assigned to me.
      where.push('(t.created_by = ? OR t.assigned_to = ?)');
      params.push(me, me);
    }
    if (projectId) { where.push('t.project_id = ?'); params.push(projectId); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await pool.query(
      `${TASK_SELECT} ${whereSql}
       ORDER BY FIELD(t.status,'in_progress','todo','blocked','done','cancelled'),
                FIELD(t.priority,'urgent','high','medium','low','none'),
                (t.due_date IS NULL), t.due_date ASC, t.created_at DESC`,
      params
    );
    await attachTags(pool, rows);
    res.json({ tasks: rows });
  } catch (err) {
    console.error('Error GET /tasks/api/tasks:', err);
    res.status(500).json({ error: 'Failed to load tasks.' });
  }
});

// Create a task.
router.post('/api/tasks', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (title.length > 255) return res.status(400).json({ error: 'Title is too long (max 255).' });

    const description = (req.body.description || '').trim() || null;
    const status = isValidStatus(req.body.status) && req.body.status !== 'cancelled' ? req.body.status : 'todo';
    const priority = isValidPriority(req.body.priority) ? req.body.priority : 'medium';
    const dueDate = normalizeDueDate(req.body.due_date);
    const tags = normalizeTags(req.body.tags);

    let assignedTo = me;
    if (req.body.assigned_to != null && req.body.assigned_to !== '') {
      const candidate = parseId(req.body.assigned_to);
      if (!candidate) return res.status(400).json({ error: 'Invalid assignee.' });
      if (candidate !== me) {
        if (!(await assignableUsername(candidate))) {
          return res.status(400).json({ error: 'Assignee must be an active mohitteam member.' });
        }
        assignedTo = candidate;
      }
    }

    let projectId = null;
    if (req.body.project_id != null && req.body.project_id !== '') {
      projectId = parseId(req.body.project_id);
      if (!projectId) return res.status(400).json({ error: 'Invalid project.' });
      const [[proj]] = await pool.query('SELECT id FROM task_projects WHERE id = ?', [projectId]);
      if (!proj) return res.status(400).json({ error: 'Project not found.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO user_tasks (title, description, status, priority, due_date, created_by, assigned_to, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, description, status, priority, dueDate, me, assignedTo, projectId]
      );
      const id = result.insertId;
      if (tags.length) await setTags(conn, id, tags);
      await conn.query(
        `INSERT INTO user_task_history (task_id, changed_by, previous_status, new_status)
         VALUES (?, ?, NULL, ?)`,
        [id, me, status]
      );
      const task = await fetchTaskById(conn, id);
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

// Edit task fields (creator/admin). title/description/priority/due_date/project_id/tags.
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

    const updates = [];
    const params = [];
    if (req.body.title !== undefined) {
      const title = (req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
      if (title.length > 255) return res.status(400).json({ error: 'Title is too long.' });
      updates.push('title = ?'); params.push(title);
    }
    if (req.body.description !== undefined) {
      updates.push('description = ?'); params.push((req.body.description || '').trim() || null);
    }
    if (req.body.priority !== undefined) {
      if (!isValidPriority(req.body.priority)) return res.status(400).json({ error: 'Invalid priority.' });
      updates.push('priority = ?'); params.push(req.body.priority);
    }
    if (req.body.due_date !== undefined) {
      updates.push('due_date = ?'); params.push(normalizeDueDate(req.body.due_date));
    }
    if (req.body.project_id !== undefined) {
      let projectId = null;
      if (req.body.project_id != null && req.body.project_id !== '') {
        projectId = parseId(req.body.project_id);
        if (!projectId) return res.status(400).json({ error: 'Invalid project.' });
        const [[proj]] = await pool.query('SELECT id FROM task_projects WHERE id = ?', [projectId]);
        if (!proj) return res.status(400).json({ error: 'Project not found.' });
      }
      updates.push('project_id = ?'); params.push(projectId);
    }

    const hasTags = req.body.tags !== undefined;
    if (!updates.length && !hasTags) return res.status(400).json({ error: 'Nothing to update.' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (updates.length) {
        await conn.query(`UPDATE user_tasks SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      }
      if (hasTags) await setTags(conn, id, normalizeTags(req.body.tags));
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
    console.error('Error PATCH /tasks/api/tasks/:id:', err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

// Set status (free-form, any -> any). Creator/assignee/admin.
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
      if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Task not found.' }); }

      const current = rows[0];
      const caps = classifyTask(current, me, isAdmin);
      if (!canSetStatus(current.status, to, caps)) {
        await conn.rollback();
        return res.status(403).json({ error: `Cannot set status to ${to}.` });
      }

      await conn.query(
        `UPDATE user_tasks SET status = ?, completed_at = ${to === 'done' ? 'NOW()' : 'NULL'} WHERE id = ?`,
        [to, id]
      );
      await conn.query(
        `INSERT INTO user_task_history (task_id, changed_by, previous_status, new_status) VALUES (?, ?, ?, ?)`,
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

// Reassign (creator/admin) to another mohitteam member.
router.patch('/api/tasks/:id/assign', gate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid task id.' });
  const newAssignee = parseId(req.body.assigned_to);
  if (!newAssignee) return res.status(400).json({ error: 'Invalid assignee.' });

  try {
    const me = req.session.user.id;
    const isAdmin = isAdminUser(req.session.user);
    const [rows] = await pool.query('SELECT status, created_by, assigned_to FROM user_tasks WHERE id = ?', [id]);
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

// Delete (creator/admin).
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
      await conn.query('DELETE FROM user_task_tags WHERE task_id = ?', [id]);
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

// History timeline (creator/assignee/admin).
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
         FROM user_task_history h JOIN users u ON u.id = h.changed_by
        WHERE h.task_id = ? ORDER BY h.changed_at ASC, h.id ASC`,
      [id]
    );
    res.json({ history });
  } catch (err) {
    console.error('Error GET /tasks/api/tasks/:id/history:', err);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

// Projects: list (with task counts) + create.
router.get('/api/projects', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    // task_count reflects only the caller's own tasks in each project — never
    // a global count that would leak how much work others have.
    const [projects] = await pool.query(
      `SELECT p.id, p.name, p.project_key, p.color,
              COUNT(t.id) AS task_count
         FROM task_projects p
         LEFT JOIN user_tasks t
           ON t.project_id = p.id AND (t.created_by = ? OR t.assigned_to = ?)
        GROUP BY p.id
        ORDER BY p.name`,
      [me, me]
    );
    res.json({ projects });
  } catch (err) {
    console.error('Error GET /tasks/api/projects:', err);
    res.status(500).json({ error: 'Failed to load projects.' });
  }
});

router.post('/api/projects', gate, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Project name is required.' });
    if (name.length > 100) return res.status(400).json({ error: 'Name too long.' });

    let key = (req.body.project_key || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!key) key = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PROJ';
    const color = (req.body.color || '').trim().slice(0, 20) || null;

    const [[exists]] = await pool.query('SELECT id FROM task_projects WHERE project_key = ?', [key]);
    if (exists) return res.status(409).json({ error: `Project key "${key}" is taken.` });

    const [result] = await pool.query(
      'INSERT INTO task_projects (name, project_key, color, created_by) VALUES (?, ?, ?, ?)',
      [name, key, color, req.session.user.id]
    );
    res.status(201).json({ project: { id: result.insertId, name, project_key: key, color, task_count: 0 } });
  } catch (err) {
    console.error('Error POST /tasks/api/projects:', err);
    res.status(500).json({ error: 'Failed to create project.' });
  }
});

// Distinct tags from the caller's own tasks (for filter + autocomplete).
router.get('/api/tags', gate, async (req, res) => {
  try {
    const me = req.session.user.id;
    const [rows] = await pool.query(
      `SELECT DISTINCT tg.tag
         FROM user_task_tags tg
         JOIN user_tasks t ON t.id = tg.task_id
        WHERE t.created_by = ? OR t.assigned_to = ?
        ORDER BY tg.tag`,
      [me, me]
    );
    res.json({ tags: rows.map((r) => r.tag) });
  } catch (err) {
    console.error('Error GET /tasks/api/tags:', err);
    res.status(500).json({ error: 'Failed to load tags.' });
  }
});

// User picker: active mohitteam members.
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
        ORDER BY u.username LIMIT 100`,
      [search, search]
    );
    res.json({ users });
  } catch (err) {
    console.error('Error GET /tasks/api/users:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

module.exports = router;
