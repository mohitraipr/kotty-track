// routes/launcherRoutes.js
//
// Post-login "pick your role" surface for multi-role users.
//
// Endpoints (all require auth):
//   GET  /launcher       — renders one card per role the user holds.
//                          Single-role users are bounced straight to
//                          their dashboard (zero-click experience preserved).
//   POST /switch-role    — body { role, password }. Verifies the password,
//                          confirms the role is in user.availableRoles,
//                          updates session.user.roleName to that role,
//                          and redirects to that role's dashboard. Audited
//                          via security_audit_log (event 'ROLE_SWITCHED').

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');
const authRoutes = require('./authRoutes');

const getDashboardForRole = authRoutes.getDashboardForRole;

// Display labels + icons for the canonical role names. Anything not listed
// falls back to a generic card with the role name title-cased.
const ROLE_META = {
  admin:                { label: 'Admin Console',          icon: 'shield-lock',    desc: 'Full system administration' },
  operator:             { label: 'Operator',               icon: 'speedometer2',   desc: 'Operations dashboard, payments, reports' },
  cutting_manager:      { label: 'Cutting Manager',        icon: 'scissors',       desc: 'Cutting lots and floor management' },
  fabric_manager:       { label: 'Fabric Manager',         icon: 'bag-fill',       desc: 'Fabric inwards and stock' },
  stitching_master:     { label: 'Stitching',              icon: 'columns-gap',    desc: 'Stitching events + payments' },
  jeans_assembly:       { label: 'Jeans Assembly',         icon: 'diagram-3',      desc: 'Assembly events + payments' },
  washing:              { label: 'Washing',                icon: 'droplet-fill',   desc: 'Washing events + payments' },
  washing_master:       { label: 'Washing',                icon: 'droplet-fill',   desc: 'Washing events + payments' },
  washing_in:           { label: 'Washing-In',             icon: 'arrow-down-circle', desc: 'Inbound from washing' },
  washing_in_master:    { label: 'Washing-In',             icon: 'arrow-down-circle', desc: 'Inbound from washing' },
  finishing:            { label: 'Finishing',              icon: 'check2-square',  desc: 'Finishing + dispatch' },
  catalogUpload:        { label: 'Catalog Upload',         icon: 'cloud-upload',   desc: 'Bulk product uploads' },
  supervisor:           { label: 'Supervisor',             icon: 'people-fill',    desc: 'Employee management' },
  store_admin:          { label: 'Store Admin',            icon: 'shop-window',    desc: 'Store administration' },
  store_employee:       { label: 'Store',                  icon: 'shop',           desc: 'Inventory entry' },
  indent_filler:        { label: 'Indents',                icon: 'card-list',      desc: 'Submit indents' },
  store_manager:        { label: 'Indent Manager',         icon: 'card-checklist', desc: 'Approve / process indents' },
  accounts:             { label: 'Accounts',               icon: 'cash-coin',      desc: 'Challans + stage payments' },
  po_creator:           { label: 'PO Creator',             icon: 'file-earmark-plus', desc: 'Create purchase orders' },
  nowipoorganization:   { label: 'NOWI PO',                icon: 'building',       desc: 'NOWI organization POs' },
  vendorfiles:          { label: 'Vendor Files',           icon: 'folder2-open',   desc: 'Vendor documents' },
  poadmin:              { label: 'PO Admin',               icon: 'kanban',         desc: 'PO administration' },
  poadmins:             { label: 'PO Admin',               icon: 'kanban',         desc: 'PO administration' },
  checking:             { label: 'Checking',               icon: 'clipboard-check', desc: 'QA checking' },
  quality_assurance:    { label: 'Quality Assurance',      icon: 'patch-check',    desc: 'QA dashboard' },
  challan_dashboard:    { label: 'Challan',                icon: 'receipt',        desc: 'Challan dashboard' },
  productviewer:        { label: 'Product Links',          icon: 'link-45deg',     desc: 'View product links' },
  wishlinkops:          { label: 'Wishlink Ops',           icon: 'plug',           desc: 'Inventory hooks + Wishlink ops' },
  videofinder:          { label: 'Video Finder',           icon: 'camera-video',   desc: 'CCTV by AWB / keyword' },
  videocreator:         { label: 'VMS Recorder',           icon: 'record-circle',  desc: 'Record packing videos' },
  vmsoperator:          { label: 'VMS Operator',           icon: 'upload',         desc: 'AWB uploads + VMS tools' },
  return_grn:           { label: 'Return GRN',             icon: 'arrow-return-left', desc: 'Return scan-in' },
  returns_operator:     { label: 'Returns Operator',       icon: 'arrow-counterclockwise', desc: 'Returns dashboard' },
  inventory_operator:   { label: 'Out-of-Stock',           icon: 'bag-x',          desc: 'OOS market view' },
  outofstock:           { label: 'Out-of-Stock',           icon: 'bag-x',          desc: 'OOS market view' },
};

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildRoleCards(user) {
  const roles = Array.isArray(user.availableRoles) ? user.availableRoles : [user.roleName].filter(Boolean);
  return roles.map((role) => {
    const meta = ROLE_META[role] || {};
    return {
      role,
      url: getDashboardForRole(role),
      label: meta.label || titleCase(role),
      icon:  meta.icon  || 'box-arrow-in-right',
      desc:  meta.desc  || 'Open dashboard',
      isActive: role === user.roleName,
      isPrimary: role === user.primaryRoleName,
    };
  });
}

// GET /launcher — pick a role
router.get('/launcher', isAuthenticated, (req, res) => {
  const user = req.session.user;
  // Single-role: skip launcher, go straight to their dashboard
  if (!user.availableRoles || user.availableRoles.length <= 1) {
    return res.redirect(getDashboardForRole(user.roleName));
  }
  const roles = buildRoleCards(user);
  res.render('launcher', {
    user,
    roles,
    flash: { error: req.flash('error'), success: req.flash('success') },
  });
});

// POST /switch-role — body { role, password }
// Verifies password (audit boundary), confirms role is owned,
// swaps active role, redirects to that role's dashboard.
router.post('/switch-role', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  const targetRole = String(req.body.role || '').trim();
  const password = String(req.body.password || '');

  const wantsJson = req.headers.accept && req.headers.accept.indexOf('application/json') !== -1;
  const fail = (msg, status = 400) => {
    if (wantsJson) return res.status(status).json({ ok: false, error: msg });
    req.flash('error', msg);
    return res.redirect('/launcher');
  };

  if (!targetRole || !password) return fail('Role and password are required.');
  if (!user.availableRoles || !user.availableRoles.includes(targetRole)) {
    return fail('You do not have access to that role.', 403);
  }

  try {
    const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [user.id]);
    if (!rows.length) return fail('Account not found.', 404);
    const match = await bcrypt.compare(password, rows[0].password);
    if (!match) {
      try {
        await pool.query(
          `INSERT INTO security_audit_log (event_type, username, details, created_at)
           VALUES ('ROLE_SWITCH_FAILED', ?, ?, NOW())`,
          [user.username, JSON.stringify({ reason: 'bad_password', target: targetRole })]
        );
      } catch (_) {}
      return fail('Incorrect password.', 401);
    }

    // Swap active role in session
    const fromRole = user.roleName;
    req.session.user.roleName = targetRole;
    req.session.user.role = targetRole;

    // Audit
    try {
      await pool.query(
        `INSERT INTO security_audit_log (event_type, username, details, created_at)
         VALUES ('ROLE_SWITCHED', ?, ?, NOW())`,
        [user.username, JSON.stringify({ from: fromRole, to: targetRole, user_id: user.id })]
      );
    } catch (_) {}

    const dest = getDashboardForRole(targetRole);
    if (wantsJson) return res.json({ ok: true, redirect: dest });
    return res.redirect(dest);
  } catch (err) {
    console.error('[switch-role] error', err);
    return fail('Could not switch role.', 500);
  }
});

module.exports = router;
