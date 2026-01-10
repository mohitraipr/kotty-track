const express = require('express');
const router = express.Router();

const featureSections = [
  {
    id: 'platform-access',
    title: 'Platform Access, Sessions & Role Guards',
    description:
      'Login, logout, and session protection keep every dashboard behind hashed credentials, cached lookups, and consistent authorization.',
    highlights: [
      'Username/password login validates hashed records, caches recent lookups, and redirects by role while capturing session metadata.',
      'Reusable middleware gates each router by role, returning JSON for API callers and flash messaging for browser users.',
      'Session activity logging closes audit trails on logout so privileged dashboards stay inaccessible once a user signs out.'
    ],
    modules: ['routes/authRoutes.js', 'routes/authRoutesOptimized.js', 'middlewares/auth.js', 'middlewares/sessionActivity.js']
  },
  {
    id: 'admin-governance',
    title: 'Administration, Audit & Dynamic Dashboards',
    description:
      'Admins curate roles, users, dashboards, and database-backed widgets while keeping audit logs and search utilities in sync.',
    highlights: [
      'Admin console lists roles, users, dashboards, and audit history together, letting admins create schemas and dashboards in one flow.',
      'Dashboard routes hydrate role-aware table views with pagination, search, and Excel export helpers for any configured dataset.',
      'Search routes cache metadata, build flexible SQL on demand, and stream filtered results to Excel without exposing raw tables.'
    ],
    modules: ['routes/adminRoutes.js', 'routes/dashboardRoutes.js', 'routes/searchRoutes.js', 'routes/featuresRoutes.js']
  },
  {
    id: 'fabric-cutting',
    title: 'Fabric Intake, Cutting Lots & Department Hand-offs',
    description:
      'Fabric managers onboard invoices and rolls, cutting managers generate lots, and department users confirm work in partial waves.',
    highlights: [
      'Fabric routes normalise spreadsheet uploads, reconcile vendors, and persist roll breakdowns for later consumption.',
      'Cutting managers generate lot numbers, attach imagery, split quantities by size, and edit lots when specs change.',
      'Department dashboards let team users mark partial completions so operators can verify and push lots forward.'
    ],
    modules: ['routes/fabricManagerRoutes.js', 'routes/cuttingManagerRoutes.js', 'routes/editcuttinglots.js', 'routes/departmentRoutes.js']
  },
  {
    id: 'stitching-assembly',
    title: 'Stitching Approvals, Assembly & Reassignments',
    description:
      'Stitching masters approve assignments, record piece-wise output, and feed assembly teams who prepare lots for washing.',
    highlights: [
      'Approval queues and history pages enforce per-size totals, accept photos, and export structured evidence for auditors.',
      'Assembly dashboards reconcile stitched lots, capture approvals, and surface PDF challans for downstream washing or dispatch.',
      'Edit flows fix assignment issues and let operators reassign or correct washing links without breaking historical data.'
    ],
    modules: ['routes/stitchingRoutes.js', 'routes/jeansAssemblyRoutes.js', 'routes/editWashingAssignments.js']
  },
  {
    id: 'washing-finishing',
    title: 'Washing Intake, Rewash & Finishing Dispatch',
    description:
      'Washing, washing-in, and finishing modules manage approvals, checkpoints, rewash loops, and final dispatch paperwork.',
    highlights: [
      'Assignment tooling pairs assembly output with washer queues, preventing duplicate submissions and keeping remarks traceable.',
      'Washing-in routes confirm arrivals, split toward rewash or finishing, and generate Excel summaries and challans.',
      'Finishing captures proofs, validates totals, and supports edits or revocations before dispatch and document printing.'
    ],
    modules: ['routes/assigntowashingRoutes.js', 'routes/washingRoutes.js', 'routes/washingInRoutes.js', 'routes/finishingRoutes.js']
  },
  {
    id: 'operator-oversight',
    title: 'Operator Command Center & Department Management',
    description:
      'Operators monitor flow health, manage departments, and coordinate supervisors with cached analytics and Excel-friendly exports.',
    highlights: [
      'Performance widgets aggregate stitched, washed, and finished totals per lot, flagging bottlenecks across denim and non-denim chains.',
      'Department management assigns supervisors, uploads attendance corrections, and reviews confirmation backlogs per stage.',
      'Supervisor tooling shows rosters, incentives, and advances with salary recalculation hooks for every attendance adjustment.'
    ],
    modules: ['routes/operatorRoutes.js', 'routes/departmentMgmtRoutes.js', 'routes/operatorEmployeeRoutes.js']
  },
  {
    id: 'workforce-payroll',
    title: 'Workforce Rosters, Attendance & Payroll Rules',
    description:
      'Supervisors and HR teams manage employee records, track daily wages, and upload attendance or night-shift data with templates.',
    highlights: [
      'Employee routes let supervisors register staff, edit metadata, and download structured rosters for offline updates.',
      'Daily wage (“dihadi”) routes create attendance entries, enforce validations, and recalculate salaries immediately.',
      'Shared salary helpers convert punch logs into monthly pay with leave, sandwich-day, and allowance logic baked in.'
    ],
    modules: ['routes/employeeRoutes.js', 'routes/dihadiRoutes.js', 'helpers/salaryCalculator.js']
  },
  {
    id: 'inventory-alerts',
    title: 'Inventory, Out-of-Stock Alerts & Store Operations',
    description:
      'Store admins and inventory operators reconcile goods, dispatch stock, and react to webhook-driven out-of-stock alerts.',
    highlights: [
      'Store admin dashboards maintain the goods master, dispatch history, and Excel exports for quick audits.',
      'Inventory dashboards handle incoming and outgoing quantities with transactional updates and on-demand Excel downloads.',
      'Webhook handlers persist threshold breaches, stream alerts via Server-Sent Events, and expose SKU alert history for operators.'
    ],
    modules: ['routes/storeAdminRoutes.js', 'routes/inventoryRoutes.js', 'routes/inventoryWebhook.js', 'routes/skuRoutes.js']
  },
  {
    id: 'procurement-po',
    title: 'Procurement, Indents, Purchase Orders & Vendor Files',
    description:
      'Accounts and procurement teams track parties, handle indents, generate POs, and share vendor files securely.',
    highlights: [
      'Purchase dashboards manage parties and factories, while indent flows log filler requests, status changes, and audit history.',
      'PO creator routes assemble inward entries with brand codes, panels, and exports, including specialised Nowi PO helpers.',
      'Vendor file routes upload Excel or image packs to S3, generate signed URLs, and bundle archives for collaborators.'
    ],
    modules: ['routes/purchaseRoutes.js', 'routes/indentRoutes.js', 'routes/poCreatorRoutes.js', 'routes/nowiPoRoutes.js', 'routes/vendorFilesRoutes.js']
  },
  {
    id: 'catalog-bulk',
    title: 'Catalog Uploads, Templates & Bulk Automation',
    description:
      'Excel-driven utilities minimise manual entry for catalog data, washing assignments, and lot updates.',
    highlights: [
      'Catalog upload routes parse marketplace sheets from S3, normalise headers, and cache marketplace metadata.',
      'Bulk upload dashboards generate templates, validate rows, and insert lots or washing assignments with rollback safety.',
      'Shared helpers keep date conversions, caching, and file handling consistent across upload-heavy flows.'
    ],
    modules: ['routes/catalogupload.js', 'routes/bulkUploadRoutes.js']
  },
  {
    id: 'integrations-apis',
    title: 'Integrations, Analytics & Partner APIs',
    description:
      'External touchpoints sync Flipkart returns, EasyEcom stock analytics, and production data over authenticated APIs.',
    highlights: [
      'API auth and production routes provide JWT-secured endpoints for lot retrieval, status updates, and metadata exports.',
      'Flipkart routes reconcile return consignments and issue statuses, while EasyEcom UI charts orders, runway, and momentum.',
      'Out-of-stock role support and warehouse scoping align EasyEcom analytics with inventory alerts seen in-store.'
    ],
    modules: ['routes/apiAuthRoutes.js', 'routes/apiRoutes.js', 'routes/productionApiRoutes.js', 'routes/flipkartReturnRoutes.js', 'routes/flipkartIssueStatusRoutes.js', 'routes/easyecomapi.js', 'routes/easyecomRoutes.js']
  },
  {
    id: 'payments-challans',
    title: 'Payments, Challans & Documentation',
    description:
      'Finance and accounts teams configure rates, reconcile payouts, and generate GST-ready challans from washing output.',
    highlights: [
      'Stitching and washing payment routes fetch rate cards, calculate amounts, and export Excel summaries per user or operation.',
      'Accounts challan routes generate GST challans from approved washing assignments, enforce counters, and render printable PDFs.',
      'Challan dashboards add vehicle and purpose metadata while keeping history searchable for audits.'
    ],
    modules: ['routes/stitchingPaymentRoutes.js', 'routes/washingPaymentRoutes.js', 'routes/accountsChallanRoutes.js', 'routes/challanDashboardRoutes.js']
  }
];

router.get('/features', (req, res) => {
  res.render('features', {
    user: req.session?.user || null,
    featureSections
  });
});

module.exports = router;
