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
 * Fetch all columns for a given table from `information_schema.columns`
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
 * Perform a partial match across multiple columns.  
 * Now supports multiple keywords in `searchTerm` by splitting on whitespace.  
 * - If no columns: SELECT *  
 * - If no searchTerm: SELECT chosen columns, no WHERE  
 * - If multiple keywords in searchTerm: each keyword must match at least one column (OR).
 */
async function searchByColumns(tableName, columns, searchTerm) {
  // No columns => do "SELECT *"
  if (!columns || !columns.length) {
    const sql = `SELECT * FROM \`${tableName}\``;
    const [allRows] = await pool.query(sql);
    return allRows;
  }

  // No searchTerm => just SELECT those columns, no WHERE
  if (!searchTerm) {
    const colList = columns.map(c => `\`${c}\``).join(', ');
    const sql = `SELECT ${colList} FROM \`${tableName}\``;
    const [allRows] = await pool.query(sql);
    return allRows;
  }

  // Parse searchTerm into multiple terms (split on whitespace)
  const terms = searchTerm.split(/\s+/).filter(Boolean);

  // Build OR conditions across all columns for each term
  // For example, for 2 terms and 2 columns, we want:
  // (col1 LIKE ? OR col2 LIKE ?) OR (col1 LIKE ? OR col2 LIKE ?)
  // This means "any column matches term1" OR "any column matches term2"
  const orBlocks = [];
  const params = [];

  terms.forEach(term => {
    const singleTermConditions = columns.map(col => `\`${col}\` LIKE ?`).join(' OR ');
    orBlocks.push(`(${singleTermConditions})`);
    // For each column, we push param
    columns.forEach(() => params.push(`%${term}%`));
  });

  const colList = columns.map(c => `\`${c}\``).join(', ');
  const whereClause = orBlocks.join(' OR '); 
  const sql = `SELECT ${colList} FROM \`${tableName}\` WHERE ${whereClause}`;

  console.log('searchByColumns =>', sql, params);
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Single route: /search-dashboard
router.route('/search-dashboard')
  // GET => Render the page with table dropdown, or columns if table is selected
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
        searchTerm: '',
        resultRows: null
      });
    } catch (err) {
      console.error('GET /search-dashboard error:', err);
      return res.status(500).send('Error loading search-dashboard');
    }
  })

  // POST => handle searching or exporting
  .post(isAuthenticated, isOperator, async (req, res) => {
    try {
      const { action, selectedTable, searchTerm } = req.body;
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
          searchTerm: '',
          resultRows: null
        });
      }

      // Get the columns
      const columnList = await getColumnsForTable(selectedTable);

      // Do the partial-match query (which now supports multiple keywords)
      const rows = await searchByColumns(selectedTable, chosenColumns, searchTerm);

      if (action === 'search') {
        // Render results
        return res.render('searchDashboard', {
          allTables,
          selectedTable,
          columnList,
          chosenColumns,
          searchTerm,
          resultRows: rows
        });
      } else if (action === 'export') {
        // Export results to Excel
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
          // Convert rows to sheet
          const wb = XLSX.utils.book_new();
          const ws = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(wb, ws, selectedTable);
          const excelBuf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
          res.setHeader('Content-Disposition', `attachment; filename="${selectedTable}_export.xlsx"`);
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          return res.send(excelBuf);
        }
      } else {
        // Unknown action => redirect
        return res.redirect('/search-dashboard');
      }
    } catch (err) {
      console.error('POST /search-dashboard error:', err);
      return res.status(500).send('Error processing search');
    }
  });

module.exports = router;
