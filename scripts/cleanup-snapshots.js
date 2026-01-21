/**
 * One-time cleanup script for ee_inventory_snapshots table
 *
 * This script deletes old snapshot data in batches to avoid locking the database.
 * It keeps only the last 7 days of data.
 *
 * Usage: node scripts/cleanup-snapshots.js
 *
 * IMPORTANT: Run this during low-traffic hours (e.g., late night)
 */

const secureEnv = require('secure-env');
global.env = secureEnv({ secret: 'mySecretPassword' });

const mysql = require('mysql2/promise');

const BATCH_SIZE = 50000;
const RETENTION_DAYS = 7;
const DELAY_BETWEEN_BATCHES_MS = 1000; // 1 second between batches

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('EE_INVENTORY_SNAPSHOTS CLEANUP SCRIPT');
  console.log('='.repeat(60));
  console.log(`Retention: ${RETENTION_DAYS} days`);
  console.log(`Batch size: ${BATCH_SIZE} rows`);
  console.log('');

  const pool = mysql.createPool({
    host: global.env.DB_HOST,
    user: global.env.DB_USER,
    password: global.env.DB_PASSWORD,
    database: global.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    // Step 1: Check current state
    console.log('STEP 1: Checking current table state...');
    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MIN(received_at) as oldest_record,
        MAX(received_at) as newest_record
      FROM ee_inventory_snapshots
    `);
    console.log(`  Total rows: ${stats.total_rows.toLocaleString()}`);
    console.log(`  Oldest record: ${stats.oldest_record}`);
    console.log(`  Newest record: ${stats.newest_record}`);
    console.log('');

    // Step 2: Count rows to delete
    console.log('STEP 2: Counting rows to delete...');
    const [[toDelete]] = await pool.query(`
      SELECT COUNT(*) as count
      FROM ee_inventory_snapshots
      WHERE received_at < DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [RETENTION_DAYS]);
    console.log(`  Rows older than ${RETENTION_DAYS} days: ${toDelete.count.toLocaleString()}`);
    console.log('');

    if (toDelete.count === 0) {
      console.log('No rows to delete. Table is already clean!');
      await pool.end();
      return;
    }

    // Step 3: Check/create index
    console.log('STEP 3: Ensuring cleanup index exists...');
    const [[indexCheck]] = await pool.query(`
      SELECT COUNT(*) as exists_flag
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ee_inventory_snapshots'
        AND INDEX_NAME = 'idx_ee_snapshots_cleanup'
    `);

    if (indexCheck.exists_flag === 0) {
      console.log('  Creating index idx_ee_snapshots_cleanup...');
      await pool.query(`
        CREATE INDEX idx_ee_snapshots_cleanup
        ON ee_inventory_snapshots(received_at)
      `);
      console.log('  Index created successfully.');
    } else {
      console.log('  Index already exists.');
    }
    console.log('');

    // Step 4: Delete in batches
    console.log('STEP 4: Deleting old data in batches...');
    let totalDeleted = 0;
    let batchNumber = 0;
    let deletedInBatch = BATCH_SIZE;

    const startTime = Date.now();

    while (deletedInBatch > 0) {
      batchNumber++;

      const [result] = await pool.query(`
        DELETE FROM ee_inventory_snapshots
        WHERE received_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        LIMIT ?
      `, [RETENTION_DAYS, BATCH_SIZE]);

      deletedInBatch = result.affectedRows;
      totalDeleted += deletedInBatch;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const progress = ((totalDeleted / toDelete.count) * 100).toFixed(1);

      console.log(`  Batch ${batchNumber}: Deleted ${deletedInBatch.toLocaleString()} rows | Total: ${totalDeleted.toLocaleString()} (${progress}%) | Elapsed: ${elapsed}s`);

      if (deletedInBatch > 0) {
        await sleep(DELAY_BETWEEN_BATCHES_MS);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(`  COMPLETED: Deleted ${totalDeleted.toLocaleString()} rows in ${totalTime} seconds`);
    console.log('');

    // Step 5: Verify results
    console.log('STEP 5: Verifying cleanup results...');
    const [[newStats]] = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MIN(received_at) as oldest_record,
        MAX(received_at) as newest_record
      FROM ee_inventory_snapshots
    `);
    console.log(`  Remaining rows: ${newStats.total_rows.toLocaleString()}`);
    console.log(`  Oldest record: ${newStats.oldest_record}`);
    console.log(`  Newest record: ${newStats.newest_record}`);
    console.log('');

    // Step 6: Suggest OPTIMIZE TABLE
    console.log('STEP 6: Reclaiming disk space...');
    console.log('  Running OPTIMIZE TABLE (this may take a few minutes)...');

    try {
      await pool.query('OPTIMIZE TABLE ee_inventory_snapshots');
      console.log('  OPTIMIZE TABLE completed successfully.');
    } catch (err) {
      console.log(`  Warning: OPTIMIZE TABLE failed: ${err.message}`);
      console.log('  You may need to run this manually: OPTIMIZE TABLE ee_inventory_snapshots;');
    }
    console.log('');

    // Summary
    console.log('='.repeat(60));
    console.log('CLEANUP COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Rows deleted: ${totalDeleted.toLocaleString()}`);
    console.log(`  Rows remaining: ${newStats.total_rows.toLocaleString()}`);
    console.log(`  Data retained: Last ${RETENTION_DAYS} days`);
    console.log('');
    console.log('NEXT STEPS:');
    console.log('  1. Deploy the updated code with the daily cleanup event');
    console.log('  2. Enable MySQL event scheduler: SET GLOBAL event_scheduler = ON;');
    console.log('  3. Create the cleanup event from sql/cleanup_ee_inventory_snapshots.sql');
    console.log('');

    await pool.end();

  } catch (err) {
    console.error('ERROR:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
