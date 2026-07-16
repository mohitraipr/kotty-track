// Kotty Analyst — chat over live production/sales/payment data.
// Audience: operators + production manager (+ admin). Mounted at /operator/ai.
// The engine (utils/aiAnalyst.js) only ever runs guarded read-only SQL; every
// conversation is persisted (ai_chats / ai_chat_messages) as an audit trail.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const analyst = require('../utils/aiAnalyst');

const guard = [isAuthenticated, allowRoles(['operator', 'production_manager', 'admin'])];

router.get('/', ...guard, async (req, res) => {
  try {
    const [chats] = await pool.query(
      `SELECT id, title, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30`,
      [req.session.user.id]
    );
    res.render('aiAnalyst', { user: req.session.user, chats });
  } catch (err) {
    console.error('[ai] page error:', err);
    res.status(500).send('Could not load Kotty Analyst: ' + err.message);
  }
});

// Messages of one chat (owner-scoped).
router.get('/chat/:id', ...guard, async (req, res) => {
  try {
    const [[chat]] = await pool.query(
      `SELECT id, title FROM ai_chats WHERE id = ? AND user_id = ?`,
      [Number(req.params.id), req.session.user.id]
    );
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const [messages] = await pool.query(
      `SELECT role, content, created_at FROM ai_chat_messages WHERE chat_id = ? ORDER BY id`,
      [chat.id]
    );
    res.json({
      ok: true,
      chat,
      messages: messages.map((m) => ({
        role: m.role,
        created_at: m.created_at,
        ...(m.role === 'assistant' ? safeParse(m.content) : { answer: m.content }),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeParse(s) {
  try { return JSON.parse(s); } catch (_e) { return { answer: String(s) }; }
}

// Ask a question. Body: { chat_id?, question }.
router.post('/ask', ...guard, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const question = String(req.body.question || '').trim().slice(0, 2000);
    if (!question) return res.status(400).json({ error: 'Ask a question first.' });

    let chatId = Number(req.body.chat_id) || null;
    if (chatId) {
      const [[chat]] = await pool.query(
        `SELECT id FROM ai_chats WHERE id = ? AND user_id = ?`, [chatId, userId]);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
    } else {
      const [ins] = await pool.query(
        `INSERT INTO ai_chats (user_id, username, title) VALUES (?, ?, ?)`,
        [userId, req.session.user.username || null, question.slice(0, 120)]
      );
      chatId = ins.insertId;
    }

    // Replay recent turns so follow-ups work ("and last month?").
    const [prior] = await pool.query(
      `SELECT role, content FROM ai_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 12`,
      [chatId]
    );
    const history = prior.reverse().map((m) => ({
      role: m.role,
      content: m.role === 'assistant' ? (safeParse(m.content).answer || '') : m.content,
    })).filter((m) => m.content);

    await pool.query(
      `INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, 'user', ?)`,
      [chatId, question]
    );

    const out = await analyst.ask(history, question);

    await pool.query(
      `INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, 'assistant', ?)`,
      [chatId, JSON.stringify(out)]
    );
    await pool.query(`UPDATE ai_chats SET updated_at = NOW() WHERE id = ?`, [chatId]);

    res.json({ ok: true, chat_id: chatId, ...out });
  } catch (err) {
    console.error('[ai] ask error:', err);
    res.status(500).json({ error: 'The analyst hit a problem: ' + (err.message || 'unknown error').slice(0, 200) });
  }
});

module.exports = router;
