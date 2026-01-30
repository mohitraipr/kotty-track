/**
 * Health Check Routes for Cloud Run
 * Add this to app.js: app.use('/health', require('./routes/healthRoutes'));
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// Simple health check - just returns OK
router.get('/', async (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed health check with database connectivity
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {}
  };

  // Check database
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    health.checks.database = { status: 'ok' };
  } catch (err) {
    health.checks.database = { status: 'error', message: err.message };
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Readiness check for Cloud Run
router.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    res.status(200).json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

// Liveness check for Cloud Run
router.get('/live', (req, res) => {
  res.status(200).json({ live: true });
});

module.exports = router;
