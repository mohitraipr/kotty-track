/**
 * Database Configuration - GCP Cloud SQL Compatible
 * Supports both Cloud Run (Unix socket) and local development (TCP)
 */

const mysql = require('mysql2/promise');

// Get environment variables
const env = global.env || process.env;

// Determine if running in Cloud Run (Cloud SQL uses Unix socket)
const isCloudRun = env.K_SERVICE || env.CLOUD_RUN;
const dbHost = env.DB_HOST || 'localhost';

// Cloud SQL socket path format: /cloudsql/PROJECT:REGION:INSTANCE
const isSocketPath = dbHost.startsWith('/cloudsql/');

// Build connection config
const connectionConfig = {
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  timezone: 'local',
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 250,
  multipleStatements: false,
  connectTimeout: 10000,
  acquireTimeout: 10000,
  debug: false
};

// Use socket or TCP based on environment
if (isSocketPath) {
  // Cloud Run: Use Unix socket for Cloud SQL
  connectionConfig.socketPath = dbHost;
  console.log(`Database: Using Cloud SQL socket: ${dbHost}`);
} else {
  // Local/other: Use TCP connection
  connectionConfig.host = dbHost;
  connectionConfig.port = parseInt(env.DB_PORT || '3306', 10);
  console.log(`Database: Using TCP connection: ${dbHost}:${connectionConfig.port}`);
}

const pool = mysql.createPool(connectionConfig);

// Test the connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('Database connected successfully!');

    // Log connection info for debugging
    const [rows] = await connection.query('SELECT @@hostname as host, @@port as port, DATABASE() as db');
    console.log('Connected to:', rows[0]);

    connection.release();
  } catch (error) {
    console.error('Database connection error:', error.message);

    // More helpful error messages
    if (error.code === 'ENOENT' && isSocketPath) {
      console.error('Cloud SQL socket not found. Make sure:');
      console.error('1. Cloud SQL instance is running');
      console.error('2. Cloud Run service has --add-cloudsql-instances flag');
      console.error('3. Service account has Cloud SQL Client role');
    }

    if (error.code === 'ECONNREFUSED') {
      console.error('Connection refused. For local dev:');
      console.error('1. Start Cloud SQL Proxy: ./cloud_sql_proxy -instances=PROJECT:REGION:INSTANCE=tcp:3306');
      console.error('2. Or use direct MySQL connection');
    }

    // Don't exit in production - let health checks handle it
    if (env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
}

testConnection();

module.exports = { pool };
