// utils/healthRefreshQueue.js
//
// Background queue for processing inventory health refreshes.
// Instead of running refreshInventoryHealth() synchronously on every webhook,
// we queue the updates and process them in batches every 30 seconds.
// This drastically reduces database load during high webhook traffic.

const { refreshInventoryHealth } = require('./easyecomAnalytics');

// Queue to hold pending health refresh requests
// Key: "sku:warehouseId", Value: { sku, warehouseId, inventory, timestamp }
const healthQueue = new Map();

// Processing state
let processing = false;
let pool = null;

// Interval reference for cleanup
let intervalId = null;

/**
 * Initialize the queue with the database pool
 * @param {object} dbPool - mysql2/promise pool instance
 */
function initHealthQueue(dbPool) {
  if (pool) {
    console.log('Health refresh queue already initialized');
    return;
  }

  pool = dbPool;

  // Process queue every 30 seconds
  intervalId = setInterval(processQueue, 30000);

  console.log('Health refresh queue initialized - processing every 30 seconds');
}

/**
 * Queue a health refresh request (non-blocking)
 * @param {string} sku - SKU to refresh
 * @param {number|null} warehouseId - Warehouse ID
 * @param {number} inventory - Current inventory level
 */
function queueHealthRefresh(sku, warehouseId, inventory) {
  if (!sku) return;

  const key = `${sku}:${warehouseId ?? 'null'}`;

  // Only keep the latest inventory value for each SKU/warehouse combo
  // This deduplicates rapid updates for the same SKU
  healthQueue.set(key, {
    sku,
    warehouseId,
    inventory,
    timestamp: Date.now(),
  });
}

/**
 * Process all queued health refresh requests
 */
async function processQueue() {
  // Skip if already processing or queue is empty
  if (processing || healthQueue.size === 0) return;

  // Skip if pool not initialized
  if (!pool) {
    console.warn('Health refresh queue: pool not initialized, skipping');
    return;
  }

  processing = true;

  // Grab all pending items and clear the queue
  const batch = [...healthQueue.values()];
  healthQueue.clear();

  console.log(`Processing ${batch.length} health refresh requests`);

  let successCount = 0;
  let errorCount = 0;

  for (const item of batch) {
    try {
      await refreshInventoryHealth(pool, {
        sku: item.sku,
        warehouseId: item.warehouseId,
        inventory: item.inventory,
      });
      successCount++;
    } catch (err) {
      errorCount++;
      console.error(`Health refresh failed for ${item.sku}:${item.warehouseId}:`, err.message);
    }
  }

  if (batch.length > 0) {
    console.log(`Health refresh complete: ${successCount} success, ${errorCount} errors`);
  }

  processing = false;
}

/**
 * Get current queue size (for monitoring)
 */
function getQueueSize() {
  return healthQueue.size;
}

/**
 * Graceful shutdown - process remaining items
 */
async function shutdown() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  // Process any remaining items
  if (healthQueue.size > 0) {
    console.log(`Shutdown: processing ${healthQueue.size} remaining health refresh requests`);
    await processQueue();
  }

  pool = null;
  console.log('Health refresh queue shutdown complete');
}

module.exports = {
  initHealthQueue,
  queueHealthRefresh,
  processQueue,
  getQueueSize,
  shutdown,
};
