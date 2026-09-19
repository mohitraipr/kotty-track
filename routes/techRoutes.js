/**
 * Tech — URL directory and route/role diagnostics for the `tech` role.
 *
 * Read-only. Two jobs:
 *   1. List every URL the app actually serves, by walking Express's own router
 *      stack. Deliberately NOT a hand-maintained list — with 78 mount prefixes
 *      across 73 route modules, a written-down list is stale the day after.
 *   2. Reconcile roles against those real routes. A role exists in the `roles`
 *      table, its landing URL lives in getDashboardForRole() (routes/authRoutes.js)
 *      and its launcher card in ROLE_META (routes/launcherRoutes.js) — three
 *      places, nothing keeping them in step. The failure mode is silent:
 *      getDashboardForRole() logs a warning for an unmapped role and drops the
 *      user on /operator/hub, which such a user usually cannot access, so
 *      "this role has no page" only ever surfaces as a confused user.
 *
 * All three inputs are read live (DB, the exported map, the router stack) so
 * this page cannot drift out of date the way a checked-in list would.
 *
 * Access is strictly 'tech' — no admin fallback, by request.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const authRoutes = require('./authRoutes');
const { ROLE_META } = require('./launcherRoutes');

const guard = [isAuthenticated, allowRoles(['tech'])];

// Express 4 mounts sub-routers as layers whose regexp encodes the prefix; the
// route paths inside them are relative, so the full URL only exists once the
// prefixes are stitched back on during the walk.
function mountPrefix(layer) {
  const m = layer.regexp && layer.regexp.source.match(/\^\\\/([^\\]*)/);
  return m && m[1] ? '/' + m[1] : '';
}

function collectRoutes(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      out.push({
        path: prefix + layer.route.path,
        methods: Object.keys(layer.route.methods).map((x) => x.toUpperCase()).sort(),
      });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPrefix(layer), out);
    }
  }
}

function listRoutes(app) {
  const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
  const out = [];
  collectRoutes(stack, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// A landing URL is "live" if some registered GET route can serve it. Compare
// against the route's parameter pattern rather than the literal string, so
// '/indent/manage' matches its route and a stale URL genuinely fails.
function routeMatches(routePath, url) {
  if (routePath === url) return true;
  const pattern = routePath.replace(/:[^/]+/g, '[^/]+').replace(/\/+$/, '');
  try {
    return new RegExp('^' + pattern + '/?$').test(url);
  } catch {
    return false;
  }
}

/**
 * Reconcile every role that actually exists (the `roles` table) against its
 * landing URL and its launcher card, and check the URL resolves to a real route.
 */
async function buildRoleReport(routes) {
  const [rows] = await pool.query('SELECT name FROM roles ORDER BY name');
  const getRoutes = routes.filter((r) => r.methods.includes('GET'));

  const roles = rows.map(({ name }) => {
    const url = authRoutes.getDashboardForRole(name);
    // Unmapped roles fall back to /operator/hub — that is the silent failure,
    // so only 'operator' itself legitimately lands there.
    const mapped = !(url === '/operator/hub' && name !== 'operator');
    return {
      role: name,
      url,
      mapped,
      card: !!(ROLE_META && ROLE_META[name]),
      live: mapped && getRoutes.some((r) => routeMatches(r.path, url)),
    };
  });

  return {
    roles,
    // Nothing at all built against the role — no landing URL, no card. The
    // worst case and the easiest to miss, because it shows up in none of the
    // checks below: the role exists, users can be granted it, and logging in
    // just dumps them on /operator/hub.
    orphan: roles.filter((r) => !r.mapped && !r.card),
    // Landing URL but no launcher card → card renders with undefined label/icon.
    missingCard: roles.filter((r) => r.mapped && !r.card),
    // Card but no landing URL → silently dumped on /operator/hub.
    missingUrl: roles.filter((r) => !r.mapped && r.card),
    // Mapped to a URL nothing serves → the page was never built or is gone.
    deadUrl: roles.filter((r) => r.mapped && !r.live),
  };
}

router.get('/', ...guard, async (req, res) => {
  try {
    const routes = listRoutes(req.app);
    const report = await buildRoleReport(routes);

    const groups = new Map();
    for (const r of routes) {
      const key = '/' + (r.path.split('/')[1] || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    res.render('tech', {
      user: req.session.user,
      groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      report,
      totals: { routes: routes.length, prefixes: groups.size, roles: report.roles.length },
    });
  } catch (err) {
    console.error('GET /tech error:', err);
    res.status(500).send('Failed to build URL directory');
  }
});

// JSON form of the same data, for scripting / monitoring.
router.get('/routes.json', ...guard, async (req, res) => {
  try {
    const routes = listRoutes(req.app);
    const report = await buildRoleReport(routes);
    res.json({ ok: true, count: routes.length, routes, report });
  } catch (err) {
    console.error('GET /tech/routes.json error:', err);
    res.status(500).json({ ok: false, error: 'Failed to build URL directory' });
  }
});

module.exports = router;
