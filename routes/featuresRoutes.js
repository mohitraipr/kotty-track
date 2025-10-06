const express = require('express');
const router = express.Router();

const featureSections = [
  {
    id: 'auth',
    title: 'Authentication & Role Guards',
    description:
      'Login, session management, and role-aware middleware protect every workflow before a dashboard even loads.',
    highlights: [
      'Login verifies hashed passwords against active user accounts and captures role metadata before redirecting to the relevant module home.',
      'Shared guards return JSON for API clients or flash messages for web flows so the same middleware protects HTML pages and REST endpoints.',
      'Logout tears down session state so privileged dashboards stay inaccessible once a user signs out.'
    ],
    modules: ['routes/authRoutes.js', 'middlewares/auth.js']
  },
  {
    id: 'admin',
    title: 'Administration & Governance',
    description:
      'Admins orchestrate the operating model by managing users, dashboards, audit trails, and dynamic table schemas.',
    highlights: [
      'Dashboard loads combine role lists, user rosters, existing dashboards, and audit history to keep control room context in one place.',
      'Schema builder forms create MySQL tables and matching dashboard metadata inside a single transaction with full validation.',
      'Every structural change records an audit log entry so administrators can trace who changed what and when.'
    ],
    modules: ['routes/adminRoutes.js', 'config/db.js']
  },
  {
    id: 'dashboards',
    title: 'Dynamic Dashboards & Search',
    description:
      'Self-service dashboards let each role explore its authorised tables with pagination, filters, exports, and column-level control.',
    highlights: [
      'Role-aware listings show only dashboards mapped to the signed-in role and protect tables behind per-user access checks.',
      'Table views support keyword search across concatenated columns, conditional filtering by ownership, and Excel downloads of the exact slice in view.',
      'Operator-grade search tooling caches metadata, builds flexible SQL on the fly, and streams massive result sets straight to Excel files.'
    ],
    modules: ['routes/dashboardRoutes.js', 'routes/searchRoutes.js']
  },
  {
    id: 'fabric',
    title: 'Fabric Procurement & Roll Intake',
    description:
      'Fabric managers reconcile invoices, capture roll breakdowns, and accelerate bulk onboarding with spreadsheet uploads.',
    highlights: [
      'Dashboard views paginate invoices with vendor joins, search filters, and creator context for day-to-day tracking.',
      'Utility helpers normalise Excel serial dates and cache vendor lookups so imports stay clean and performant.',
      'Bulk upload endpoints parse XLSX files, upsert vendor references, and insert invoice and roll records inside managed transactions.'
    ],
    modules: ['routes/fabricManagerRoutes.js']
  },
  {
    id: 'cutting',
    title: 'Cutting Lots & Assignments',
    description:
      'Cutting managers generate lot numbers, attach imagery, track size splits, and push work downstream with full visibility.',
    highlights: [
      'Dashboard bootstraps transactional lot numbers per user session, hydrates recent lots, and caches available fabric rolls by fabric type.',
      'Lot creation stores per-size breakdowns, optional reference photos, and user attribution before surfacing lots to other departments.',
      'Assignment tooling targets stitching, washing, and QA roles while exposing PDF challan generation for hand-off paperwork.'
    ],
    modules: ['routes/cuttingManagerRoutes.js', 'routes/editcuttinglots.js']
  },
  {
    id: 'stitching',
    title: 'Stitching Execution & Records',
    description:
      'Stitching masters approve work, capture progress with photos, and export evidence for finance and planning teams.',
    highlights: [
      'Approval queues list pending assignments with search filters so supervisors can green-light or reject lots with remarks.',
      'Data entry screens enforce per-size totals, attach upload evidence, and keep history paginated with incremental loading APIs.',
      'Excel exports, challan creation, and edit routes help correct mistakes while keeping auditors supplied with structured data.'
    ],
    modules: ['routes/stitchingRoutes.js', 'routes/stitchingPaymentRoutes.js']
  },
  {
    id: 'assembly',
    title: 'Jeans Assembly & Washing Handovers',
    description:
      'Assembly teams reconcile stitched output, approve inbound lots, and prepare washing assignments without leaving the module.',
    highlights: [
      'Controllers fetch pending stitching approvals, enforce role-based checks, and record per-size assembly totals with images.',
      'Lists show historical assembly records with Excel downloads and PDF challans for downstream washing or dispatch.',
      'Bulk approval and reassignment flows ensure only validated lots move into washing or rework pipelines.'
    ],
    modules: ['routes/jeansAssemblyRoutes.js', 'routes/assigntowashingRoutes.js']
  },
  {
    id: 'washing',
    title: 'Washing Intake, Processing & Payments',
    description:
      'Specialised dashboards manage washer approvals, washing-in checkpoints, rewash loops, and payout reconciliation.',
    highlights: [
      'Washing dashboards surface approved lots, guard against duplicate submissions, and capture per-size washed totals with imagery.',
      'Washing-in routes confirm inbound loads, split pieces towards finishing or rewash, and emit challans and Excel summaries.',
      'Payment modules fetch rate cards, calculate invoices per washer, and give operators searchable histories of prior settlements.'
    ],
    modules: ['routes/washingRoutes.js', 'routes/washingInRoutes.js', 'routes/washingPaymentRoutes.js']
  },
  {
    id: 'finishing',
    title: 'Finishing & Dispatch Management',
    description:
      'Finishing teams wrap production by validating quantities, creating challans, and coordinating dispatch readiness.',
    highlights: [
      'Creation flows validate approvals from washing, enforce size-level totals, and support optional proof images before records post.',
      'Operators can edit or revoke entries, generate department-wise challans, and review paginated histories of every finishing action.',
      'Dispatch tooling handles partial or full loads, Excel-based bulk uploads, and printable documents for logistics partners.'
    ],
    modules: ['routes/finishingRoutes.js']
  },
  {
    id: 'operator',
    title: 'Operator Command Center & Department Oversight',
    description:
      'Operators monitor throughput, manage departments, and coordinate staffing from a single cached analytics hub.',
    highlights: [
      'Analytics aggregate stitched, washed, and finished totals per operator, highlight pending lots, and surface SKU momentum trends.',
      'Department management screens assign supervisors, configure departments, and review confirmation backlogs per production stage.',
      'Operator employee tools track workers, incentives, advances, and washing assignments with Excel exports for payroll teams.'
    ],
    modules: [
      'routes/operatorRoutes.js',
      'routes/departmentMgmtRoutes.js',
      'routes/operatorEmployeeRoutes.js'
    ]
  },
  {
    id: 'workforce',
    title: 'Supervisor & Workforce Tools',
    description:
      'Supervisors and HR partners manage rosters, attendance, and daily wages with targeted utilities.',
    highlights: [
      'Supervisors review assigned employees, update worker metadata, and download structured rosters for offline use.',
      'Daily wage (“dihadi”) routes create attendance entries, calculate pay, and support Excel templates for bulk imports.',
      'Shared helpers keep flash messaging and validation consistent across workforce-facing forms.'
    ],
    modules: ['routes/employeeRoutes.js', 'routes/dihadiRoutes.js']
  },
  {
    id: 'inventory',
    title: 'Inventory & Store Operations',
    description:
      'Store admins reconcile goods in, goods out, and adjustments while keeping alerts and audit trails in sync.',
    highlights: [
      'Dashboard joins stock masters with incoming and dispatched movements while caching catalog data for quick load times.',
      'Stock adjustments run inside transactions to keep quantities balanced and capture who performed each movement.',
      'Excel exports, SSE alert streams, and webhook log viewers give store teams real-time visibility into stock events.'
    ],
    modules: ['routes/inventoryRoutes.js', 'routes/storeAdminRoutes.js', 'routes/inventoryWebhook.js']
  },
  {
    id: 'procurement',
    title: 'Purchase & Master Data Management',
    description:
      'Accounts teams maintain vendor, party, and factory masters alongside procurement utilities.',
    highlights: [
      'Purchase routes list parties and factories, support inline CRUD, and provide ready-made Excel templates.',
      'SKU utilities centralise product definitions so cutting, stitching, and inventory flows stay aligned.',
      'Data validations and flash messaging keep master data clean without direct database access.'
    ],
    modules: ['routes/purchaseRoutes.js', 'routes/skuRoutes.js']
  },
  {
    id: 'integrations',
    title: 'Integrations, APIs & Webhooks',
    description:
      'External touchpoints connect Flipkart services, internal APIs, and real-time webhooks to the production backbone.',
    highlights: [
      'Authenticated routes fetch Flipkart return consignments and issue statuses using seller credentials for reconciliation.',
      'Inventory webhooks accept JSON payloads, persist change logs, and fan out alerts over Server-Sent Events.',
      'JWT-protected APIs expose inventory summaries and fabric availability for partners and satellite tools.'
    ],
    modules: [
      'routes/flipkartReturnRoutes.js',
      'routes/flipkartIssueStatusRoutes.js',
      'routes/apiAuthRoutes.js',
      'routes/apiRoutes.js',
      'routes/inventoryWebhook.js'
    ]
  },
  {
    id: 'bulk-automation',
    title: 'Bulk Upload & Catalog Automation',
    description:
      'Excel-driven utilities reduce manual entry for SKU catalogs, washing assignments, and production updates.',
    highlights: [
      'Catalog upload routes parse Excel sheets, normalise headers, and batch insert catalog entries with progress feedback.',
      'Bulk upload helpers reuse parsing logic to assign lots to washing or update production datasets safely.',
      'Reusable date conversion and validation helpers keep spreadsheet data consistent across modules.'
    ],
    modules: ['routes/catalogupload.js', 'routes/bulkUploadRoutes.js', 'routes/assigntowashingRoutes.js']
  }
];

router.get('/features', (req, res) => {
  res.render('features', {
    user: req.session?.user || null,
    featureSections
  });
});

module.exports = router;
