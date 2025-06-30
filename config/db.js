// config/db.js
const mysql = require('mysql2/promise');

// Use environment variables directly (no need for || 'defaults' anymore)
const pool = mysql.createPool({
    host: global.env.DB_HOST,
    user: global.env.DB_USER,
    password: global.env.DB_PASSWORD,
    database: global.env.DB_NAME,
    port: parseInt(global.env.DB_PORT, 10), // Important: Parse port to integer
    timezone: 'Z', // Ensure dates are returned without timezone shifts
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Add debug option for troubleshooting (optional)
    debug: false // Set to true for more verbose output
});

// Test the connection immediately after creating the pool
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('Database connected successfully!');
        connection.release(); // Important: Release the connection back to the pool
    } catch (error) {
        console.error('Database connection error:', error);
        global.exit(1); // Exit if the connection fails on startup
    }
}

testConnection(); // Call the test function

module.exports = { pool };
