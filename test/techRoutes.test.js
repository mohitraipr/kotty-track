const { test } = require('node:test');
const assert = require('node:assert');

// /tech exposes the whole route map and the role reconciliation, so a missing
// guard here leaks the app's attack surface to any logged-in user. Access is
// strictly 'tech' — deliberately no admin fallback.
test('tech router: every route is guarded and GET-only', () => {
  process.env.SKIP_DB_CONNECT = '1';
  const router = require('../routes/techRoutes');
  const routes = router.stack.filter((l) => l.route);
  assert.ok(routes.length >= 2, 'expected the directory page and its JSON form');
  for (const layer of routes) {
    // stack per route: [isAuthenticated, allowRoles(['tech']), handler]
    assert.ok(layer.route.stack.length >= 3, `${layer.route.path} missing guards`);
    assert.strictEqual(layer.route.stack[0].handle.name, 'isAuthenticated',
      `${layer.route.path} first middleware must be isAuthenticated`);
    // read-only surface: GET only
    assert.deepStrictEqual(Object.keys(layer.route.methods), ['get'],
      `${layer.route.path} must be GET-only`);
  }
});

// The role's landing URL and its launcher card live in two separate files from
// the role itself; a role wired into only some of them is the exact silent
// failure /tech exists to report, so it must not ship with that bug itself.
test('tech role is wired end-to-end (landing URL + launcher card)', () => {
  process.env.SKIP_DB_CONNECT = '1';
  const authRoutes = require('../routes/authRoutes');
  const { ROLE_META } = require('../routes/launcherRoutes');

  assert.strictEqual(authRoutes.getDashboardForRole('tech'), '/tech',
    'tech must map to /tech, not the /operator/hub fallback');
  assert.ok(ROLE_META && ROLE_META.tech, 'tech needs a launcher card');
  assert.ok(ROLE_META.tech.label && ROLE_META.tech.icon,
    'launcher card needs a label and icon or it renders undefined');
});
