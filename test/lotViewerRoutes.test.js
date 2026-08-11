const { test } = require('node:test');
const assert = require('node:assert');

// The route module must exist, and every layer must carry the auth guards —
// a read-only viewer surface with a missing guard is an access-control bug.
test('lot-view router: every route is guarded and GET-only', () => {
  process.env.SKIP_DB_CONNECT = '1';
  const router = require('../routes/lotViewerRoutes');
  const routes = router.stack.filter((l) => l.route);
  assert.ok(routes.length >= 3, 'expected the three lot-view routes');
  for (const layer of routes) {
    // stack per route: [isAuthenticated, allowRoles(...), handler]
    assert.ok(layer.route.stack.length >= 3, `${layer.route.path} missing guards`);
    assert.strictEqual(layer.route.stack[0].handle.name, 'isAuthenticated',
      `${layer.route.path} first middleware must be isAuthenticated`);
    // read-only surface: GET only
    assert.deepStrictEqual(Object.keys(layer.route.methods), ['get'],
      `${layer.route.path} must be GET-only`);
  }
});
