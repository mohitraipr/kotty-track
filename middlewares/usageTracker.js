/**
 * Feature Usage Tracking Middleware
 *
 * Tracks route usage for analytics dashboard.
 * Uses async fire-and-forget pattern to avoid adding latency.
 */

const { pool } = require('../config/db');

// Feature name mapping based on route prefixes
const ROUTE_FEATURES = {
  '/cutting-manager': 'Cutting',
  '/stitchingdashboard': 'Stitching',
  '/stitching': 'Stitching',
  '/jeansassemblydashboard': 'Jeans Assembly',
  '/jeans-assembly': 'Jeans Assembly',
  '/washingdashboard': 'Washing',
  '/washing': 'Washing',
  '/washingin': 'Washing In',
  '/finishingdashboard': 'Finishing',
  '/finishing': 'Finishing',
  '/fabric-manager': 'Fabric Manager',
  '/easyecom': 'Inventory',
  '/webhook': 'Webhooks',
  '/returns': 'Returns',
  '/po-creator': 'PO Creator',
  '/challan': 'Challan',
  '/product-links': 'Product Links',
  '/operator': 'Operator',
  '/admin': 'Admin',
  '/store-admin': 'Store Admin',
  '/po-admin': 'PO Admin',
  '/accounts': 'Accounts',
  '/catalog-search': 'Catalog Search',
  '/vendor-files': 'Vendor Files',
  '/indent-manager': 'Indent Manager',
  '/mail-manager': 'Mail Manager',
};

// Routes to skip tracking (health checks, static assets, etc.)
const SKIP_ROUTES = [
  '/health',
  '/favicon.ico',
  '/css',
  '/js',
  '/images',
  '/socket.io',
  '/_next',
  '/api/health',
];

/**
 * Get feature name from route path
 */
function getFeatureName(path) {
  for (const [prefix, feature] of Object.entries(ROUTE_FEATURES)) {
    if (path.startsWith(prefix)) {
      return feature;
    }
  }
  return 'Other';
}

/**
 * Check if route should be tracked
 */
function shouldTrack(path) {
  // Skip static assets and health checks
  for (const skip of SKIP_ROUTES) {
    if (path.startsWith(skip)) {
      return false;
    }
  }
  // Only track GET requests to pages (not API calls unless they're main routes)
  return true;
}

/**
 * Track usage asynchronously (fire and forget)
 */
async function trackUsage(featureName, routePath, userId, username, responseTimeMs) {
  try {
    await pool.query(
      `INSERT INTO feature_usage (feature_name, route_path, user_id, username, response_time_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [featureName, routePath, userId, username, responseTimeMs]
    );
  } catch (err) {
    // Silently fail - don't break the app for analytics
    if (process.env.NODE_ENV !== 'production') {
      console.error('Usage tracking error:', err.message);
    }
  }
}

/**
 * Express middleware for tracking feature usage
 */
function usageTrackerMiddleware(req, res, next) {
  // Only track GET requests (page views)
  if (req.method !== 'GET') {
    return next();
  }

  // Check if route should be tracked
  if (!shouldTrack(req.path)) {
    return next();
  }

  const startTime = Date.now();
  const originalEnd = res.end;
  const path = req.path;
  const featureName = getFeatureName(path);

  // Override res.end to capture response time
  res.end = function(...args) {
    const responseTimeMs = Date.now() - startTime;
    const userId = req.session?.user?.id || null;
    const username = req.session?.user?.username || null;

    // Track asynchronously - don't wait for it
    setImmediate(() => {
      trackUsage(featureName, path, userId, username, responseTimeMs);
    });

    // Call original end
    originalEnd.apply(this, args);
  };

  next();
}

/**
 * Get usage statistics for a date range
 */
async function getUsageStats(startDate, endDate) {
  const params = [];
  let dateFilter = '';

  if (startDate && endDate) {
    dateFilter = 'WHERE timestamp BETWEEN ? AND ?';
    params.push(startDate, endDate);
  } else {
    dateFilter = 'WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
  }

  const [byFeature] = await pool.query(`
    SELECT
      feature_name,
      COUNT(*) as total_hits,
      COUNT(DISTINCT user_id) as unique_users,
      AVG(response_time_ms) as avg_response_ms
    FROM feature_usage
    ${dateFilter}
    GROUP BY feature_name
    ORDER BY total_hits DESC
  `, params);

  const [byDay] = await pool.query(`
    SELECT
      DATE(timestamp) as date,
      COUNT(*) as total_hits,
      COUNT(DISTINCT user_id) as unique_users
    FROM feature_usage
    ${dateFilter}
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `, params);

  const [topRoutes] = await pool.query(`
    SELECT
      route_path,
      feature_name,
      COUNT(*) as total_hits
    FROM feature_usage
    ${dateFilter}
    GROUP BY route_path, feature_name
    ORDER BY total_hits DESC
    LIMIT 20
  `, params);

  return { byFeature, byDay, topRoutes };
}

module.exports = {
  usageTrackerMiddleware,
  getUsageStats,
  trackUsage,
  getFeatureName
};
