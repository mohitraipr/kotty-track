const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { pool } = require('../config/db'); // your MySQL connection pool
const { isAuthenticated, isOperator } = require('../middlewares/auth');

const CURRENT_DB = process.env.DB_NAME || 'kotty_track';

/** 
 * Fetch all table names from `information_schema.tables`
 */
async function getAllTables() {
  const sql = `
    SELECT table_name as table_name
    FROM information_schema.tables
    WHERE table_schema = ?
    ORDER BY table_name
  `;
  try {
    const [rows] = await pool.query(sql, [CURRENT_DB]);
    return rows.map(r => r.table_name);
  } catch (err) {
    console.error('Error in getAllTables:', err);
    return [];
  }
}

/** 
 * Fetch all columns for a given table
 */
async function getColumnsForTable(tableName) {
  const sql = `
    SELECT column_name as column_name
    FROM information_schema.columns
    WHERE table_schema = ?
      AND table_name = ?
    ORDER BY ordinal_position
  `;
  try {
    const [rows] = await pool.query(sql, [CURRENT_DB, tableName]);
    return rows.map(r => r.column_name);
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
async function searchByColumns(tableName, columns, searchTerm, primaryColumn) {
  // If no columns are selected, do "SELECT *" 
  // (meaning the user doesn't pick anything to display)
  if (!columns || !columns.length) {
    const sql = `SELECT * FROM \`${tableName}\``;
    const [allRows] = await pool.query(sql);
    return allRows;
  }

  // Build "SELECT col1, col2, ..." 
  const colList = columns.map(c => `\`${c}\``).join(', ');

  // If searchTerm is empty, just SELECT columns with no WHERE
  if (!searchTerm) {
    const sql = `SELECT ${colList} FROM \`${tableName}\``;
    const [rows] = await pool.query(sql);
    return rows;
  }

  // Parse multiple space-separated terms
  const terms = searchTerm.split(/\s+/).filter(Boolean);

  let whereClause = '';
  let params = [];

  if (primaryColumn && columns.includes(primaryColumn)) {
    // 1) Searching in a single "primary" column
    // e.g. for terms ["abc","def"], we do:
    // (primaryColumn LIKE ? OR primaryColumn LIKE ?)
    // with each OR block for multiple terms => Actually we want an OR across the terms:
    //   (col LIKE ? OR col LIKE ? OR col LIKE ?)
    // But typically you might do: col LIKE ? AND col LIKE ? for an AND logic. 
    // The user wants OR logic across multiple terms? Usually it's OR logic.
    // We'll do: for each term => primaryColumn LIKE ? => OR
    // So for 2 terms => (lot_no LIKE ? OR lot_no LIKE ?)
    const orConditions = terms.map(() => `\`${primaryColumn}\` LIKE ?`).join(' OR ');
    whereClause = `WHERE (${orConditions})`;
    // Fill params
    terms.forEach(t => params.push(`%${t}%`));
  } else {
    // 2) Searching across ALL chosen columns
    // This is your existing logic:
    // (col1 LIKE ? OR col2 LIKE ?) OR (col1 LIKE ? OR col2 LIKE ?) ...
    const orBlocks = [];
    terms.forEach(term => {
      const singleTermConditions = columns.map(col => `\`${col}\` LIKE ?`).join(' OR ');
      orBlocks.push(`(${singleTermConditions})`);
      // For each column, we push param
      columns.forEach(() => params.push(`%${term}%`));
    });
    whereClause = `WHERE ${orBlocks.join(' OR ')}`;
  }

  const sql = `SELECT ${colList} FROM \`${tableName}\` ${whereClause}`;
  console.log('[searchByColumns]', sql, params);
  const [rows] = await pool.query(sql, params);
  return rows;
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

      // Perform the query
      const rows = await searchByColumns(
        selectedTable,
        chosenColumns,
        searchTerm,
        primaryColumn
      );

      // Based on action
      if (action === 'search') {
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
        if (!rows.length) {
          // No data => "No Data" file
          const wbEmpty = XLSX.utils.book_new();
          const wsEmpty = XLSX.utils.aoa_to_sheet([['No Data']]);
          XLSX.utils.book_append_sheet(wbEmpty, wsEmpty, 'NoData');
          const emptyBuf = XLSX.write(wbEmpty, { bookType: 'xlsx', type: 'buffer' });
          res.setHeader('Content-Disposition', 'attachment; filename="no_data.xlsx"');
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          return res.send(emptyBuf);
        } else {
          // Convert rows to Excel
          const wb = XLSX.utils.book_new();
          const ws = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(wb, ws, selectedTable);
          const excelBuf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
          res.setHeader('Content-Disposition', `attachment; filename="${selectedTable}_export.xlsx"`);
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          return res.send(excelBuf);
        }
      } else {
        return res.redirect('/search-dashboard');
      }
    } catch (err) {
      console.error('POST /search-dashboard error:', err);
      return res.status(500).send('Error processing search');
    }
  });

module.exports = router;
