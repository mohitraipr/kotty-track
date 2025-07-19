const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../config/db'); // your MySQL connection pool
const { isAuthenticated, isOperator } = require('../middlewares/auth');

const CURRENT_DB = process.env.DB_NAME || 'kotty_track';

// simple in-memory caches to avoid repeated metadata queries
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let tablesCache = { timestamp: 0, data: null };
const columnsCache = {}; // { tableName: { timestamp, data } }

// Cache for search results (avoid repeated heavy queries)
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 50;
const searchCache = new Map();

function getCachedResult(key) {
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    return cached.data;
  }
  if (cached) searchCache.delete(key);
  return null;
}

function setCachedResult(key, data) {
  if (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { data, ts: Date.now() });
}

const DEFAULT_LIMIT = 500; // limit rows when displaying results

/**
 * Build the SQL query and params for a search request.
 */
function buildSearchQuery(tableName, columns, searchTerm, primaryColumn, limit) {
  if (!columns || !columns.length) {
    const sql = `SELECT * FROM \`${tableName}\`${limit ? ' LIMIT ?' : ''}`;
    const params = [];
    if (limit) params.push(Number(limit));
    return { sql, params };
  }

  const colList = columns.map(c => `\`${c}\``).join(', ');

  if (!searchTerm) {
    const sql = `SELECT ${colList} FROM \`${tableName}\`${limit ? ' LIMIT ?' : ''}`;
    const params = [];
    if (limit) params.push(Number(limit));
    return { sql, params };
  }

  const terms = searchTerm.split(/\s+/).filter(Boolean);

  let whereClause = '';
  let params = [];

  if (primaryColumn && columns.includes(primaryColumn)) {
    const orConditions = terms.map(() => `\`${primaryColumn}\` LIKE ?`).join(' OR ');
    whereClause = `WHERE (${orConditions})`;
    terms.forEach(t => params.push(`%${t}%`));
  } else {
    const concatCols = columns.map(col => `COALESCE(\`${col}\`, '')`).join(", ' ', ");
    const concatExpr = `CONCAT_WS(' ', ${concatCols})`;
    const orConditions = terms.map(() => `${concatExpr} LIKE ?`).join(' OR ');
    whereClause = `WHERE (${orConditions})`;
    terms.forEach(t => params.push(`%${t}%`));
  }

  const sql = `SELECT ${colList} FROM \`${tableName}\` ${whereClause}${limit ? ' LIMIT ?' : ''}`;
  if (limit) params.push(Number(limit));
  return { sql, params };
}

/** 
 * Fetch all table names from `information_schema.tables`
 */
async function getAllTables() {
  // return cached result if valid
  if (tablesCache.data && Date.now() - tablesCache.timestamp < CACHE_TTL) {
    return tablesCache.data;
  }

  const sql = `
    SELECT table_name as table_name
    FROM information_schema.tables
    WHERE table_schema = ?
    ORDER BY table_name
  `;
  try {
    const [rows] = await pool.query(sql, [CURRENT_DB]);
    const tableNames = rows.map(r => r.table_name);
    tablesCache = { data: tableNames, timestamp: Date.now() };
    return tableNames;
  } catch (err) {
    console.error('Error in getAllTables:', err);
    return [];
  }
}

/** 
 * Fetch all columns for a given table
 */
async function getColumnsForTable(tableName) {
  const cached = columnsCache[tableName];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const sql = `
    SELECT column_name as column_name
    FROM information_schema.columns
    WHERE table_schema = ?
      AND table_name = ?
    ORDER BY ordinal_position
  `;
  try {
    const [rows] = await pool.query(sql, [CURRENT_DB, tableName]);
    const cols = rows.map(r => r.column_name);
    columnsCache[tableName] = { data: cols, timestamp: Date.now() };
    return cols;
  } catch (err) {
    console.error(`Error in getColumnsForTable(${tableName}):`, err);
    return [];
  }
}

/**
 * Perform a partial match with the possibility of searching in one “primary” column
 * or across all chosen columns, using multiple keywords (split by whitespace).
 *
 * @param {string} tableName
 * @param {string[]} columns   - The columns to SELECT (display)
 * @param {string} searchTerm  - Possibly multiple keywords, e.g. "abc def"
 * @param {string} primaryColumn - If set, only search in this column; if empty, search in all chosen columns
 * @returns rows
 */
async function searchByColumns(tableName, columns, searchTerm, primaryColumn, limit) {
  const cacheKey = JSON.stringify({ tableName, columns, searchTerm, primaryColumn, limit });
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  const { sql, params } = buildSearchQuery(tableName, columns, searchTerm, primaryColumn, limit);
  if (process.env.DEBUG_SEARCH) {
    console.log('[searchByColumns]', sql, params);
  }
  const [rows] = await pool.query(sql, params);
  setCachedResult(cacheKey, rows);
  return rows;
}

/**
 * Stream search results directly to an Excel file to avoid high memory usage.
 */
async function streamSearchToExcel(tableName, columns, searchTerm, primaryColumn, res) {
  const { sql, params } = buildSearchQuery(tableName, columns, searchTerm, primaryColumn, null);

  const conn = await pool.getConnection();
  try {
    const queryStream = conn.query(sql, params).stream({ highWaterMark: 100 });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = workbook.addWorksheet(tableName);

    let columnsSet = false;
    let hasRow = false;

    queryStream.on('data', row => {
      if (!columnsSet) {
        ws.columns = Object.keys(row).map(k => ({ header: k, key: k }));
        columnsSet = true;
      }
      ws.addRow(row).commit();
      hasRow = true;
    });

    return new Promise((resolve, reject) => {
      queryStream.on('end', async () => {
        if (!hasRow) {
          ws.addRow(['No Data']).commit();
        }
        await workbook.commit();
        conn.release();
        resolve();
      });
      queryStream.on('error', async err => {
        console.error('Error streaming export:', err);
        try { await workbook.commit(); } catch (e) { /* ignore */ }
        conn.release();
        reject(err);
      });
    });
  } catch (err) {
    conn.release();
    throw err;
  }
}

// Single route: /search-dashboard
router.route('/search-dashboard')
  .get(isAuthenticated, isOperator, async (req, res) => {
    try {
      const allTables = await getAllTables();
      const selectedTable = req.query.table || '';

      let columnList = [];
      if (selectedTable && allTables.includes(selectedTable)) {
        columnList = await getColumnsForTable(selectedTable);
      }

      // Render with empty results
      res.render('searchDashboard', {
        allTables,
        selectedTable,
        columnList,
        chosenColumns: [],
        primaryColumn: '',     // new
        searchTerm: '',
        resultRows: null
      });
    } catch (err) {
      console.error('GET /search-dashboard error:', err);
      return res.status(500).send('Error loading search-dashboard');
    }
  })
  .post(isAuthenticated, isOperator, async (req, res) => {
    try {
      const { action, selectedTable, searchTerm, primaryColumn } = req.body;
      // chosenColumns might be an array or a single string
      let chosenColumns = req.body.chosenColumns || [];
      if (!Array.isArray(chosenColumns)) {
        chosenColumns = [chosenColumns];
      }

      const allTables = await getAllTables();

      // Validate table
      if (!selectedTable || !allTables.includes(selectedTable)) {
        return res.render('searchDashboard', {
          allTables,
          selectedTable: '',
          columnList: [],
          chosenColumns: [],
          primaryColumn: '',
          searchTerm: '',
          resultRows: null
        });
      }

      // Get the columns for the chosen table
      const columnList = await getColumnsForTable(selectedTable);

      if (action === 'search') {
        const rows = await searchByColumns(
          selectedTable,
          chosenColumns,
          searchTerm,
          primaryColumn,
          DEFAULT_LIMIT
        );
        return res.render('searchDashboard', {
          allTables,
          selectedTable,
          columnList,
          chosenColumns,
          primaryColumn,
          searchTerm,
          resultRows: rows
        });
      } else if (action === 'export') {
        res.setHeader('Content-Disposition', `attachment; filename="${selectedTable}_export.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await streamSearchToExcel(selectedTable, chosenColumns, searchTerm, primaryColumn, res);
        return;
      } else {
        return res.redirect('/search-dashboard');
      }
    } catch (err) {
      console.error('POST /search-dashboard error:', err);
      return res.status(500).send('Error processing search');
    }
  });

module.exports = router;
