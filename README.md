# Kotty Track

Kotty Track is a Node.js and Express application that orchestrates the full garment production lifecycle—starting from procurement and indents, through cutting, stitching, washing, finishing, inventory, payroll, and billing—while keeping operators, supervisors, store teams, and finance users aligned. Dashboards are rendered with EJS, data is stored in MySQL, and role-aware middleware secures both HTML pages and APIs.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables for the database, session secret, file storage, push keys, and any integration tokens. The project expects encrypted environment files managed with [`secure-env`](https://www.npmjs.com/package/secure-env); generate `env.enc` in the project root before running the app.
3. Ensure a MySQL database is available with the tables used across production, payroll, procurement, and inventory modules.

Start the server with:
```bash
npm start
```
The app listens on the port defined by `PORT` (defaults to `3000`).

## Feature Map (by Route)

The platform is organised by route files so you can trace how each module works and how data flows between them.

### Platform Access, Sessions & Role Guards
- `routes/authRoutes.js`, `routes/authRoutesOptimized.js`: Hash-based login, cached lookups, and logout with session teardown.
- `middlewares/auth.js`, `middlewares/sessionActivity.js`: Role checks for every dashboard/API plus session activity logging for audits.

### Administration, Audit & Dynamic Dashboards
- `routes/adminRoutes.js`: Role, user, dashboard, and schema management with audit logging.
- `routes/dashboardRoutes.js`: Role-aware dashboard listings with search, pagination, and export helpers.
- `routes/searchRoutes.js`: Metadata-cached search that builds flexible SQL and streams Excel downloads.
- `routes/featuresRoutes.js`: Renders the feature overview page.

### Fabric Intake, Cutting & Department Hand-offs
- `routes/fabricManagerRoutes.js`: Spreadsheet-driven invoice and roll onboarding with vendor reconciliation.
- `routes/cuttingManagerRoutes.js`, `routes/editcuttinglots.js`: Lot generation, size splits, attachments, and corrections.
- `routes/departmentRoutes.js`: Department users confirm partial progress so operators can verify and advance work.

### Stitching Approvals, Assembly & Reassignments
- `routes/stitchingRoutes.js`: Approve stitching assignments, capture per-size outputs with photos, and export logs.
- `routes/jeansAssemblyRoutes.js`: Reconcile stitched lots, approve assembly output, and generate challans for downstream steps.
- `routes/editWashingAssignments.js`: Fix or reassign washing links without losing history.

### Washing Intake, Rewash & Finishing Dispatch
- `routes/assigntowashingRoutes.js`: Pair assembly output with washer queues using cached dropdowns.
- `routes/washingRoutes.js`, `routes/washingInRoutes.js`: Washing dashboards, arrival checks, rewash loops, Excel summaries, and challans.
- `routes/finishingRoutes.js`: Validate totals, attach proofs, edit or revoke entries, and prepare dispatch documents.

### Operator Command Center & Department Management
- `routes/operatorRoutes.js`: Cached analytics for lot progress across denim/non-denim chains plus bottleneck highlights.
- `routes/departmentMgmtRoutes.js`: Department configuration, supervisor assignment, and attendance correction uploads.
- `routes/operatorEmployeeRoutes.js`: Supervisor rosters, incentives, advances, and salary recalculation hooks.

### Workforce Rosters, Attendance & Payroll Rules
- `routes/employeeRoutes.js`: Supervisor-facing CRUD for employees with roster exports.
- `routes/dihadiRoutes.js`: Daily wage attendance capture with immediate salary recalculation and Excel templates.
- `helpers/salaryCalculator.js`: Salary logic covering lunch breaks, allowances, leave rules, sandwich days, and night shifts.

### Inventory, Out-of-Stock Alerts & Store Operations
- `routes/storeAdminRoutes.js`: Goods master maintenance and dispatch history with cached lookups.
- `routes/inventoryRoutes.js`: Incoming/outgoing stock with transactional updates and Excel downloads.
- `routes/inventoryWebhook.js`: Webhook ingestion for stock thresholds, alert persistence, and SSE broadcasts.
- `routes/skuRoutes.js`: SKU alert history and detail views so operators can react to out-of-stock signals.

### Procurement, Indents, Purchase Orders & Vendor Files
- `routes/purchaseRoutes.js`: Party and factory management with inline CRUD and templates.
- `routes/indentRoutes.js`: Filler requests, store manager approvals, status changes, and audit logging.
- `routes/poCreatorRoutes.js`, `routes/nowiPoRoutes.js`: PO dashboards, inward entries, brand/panel mapping, and exports.
- `routes/vendorFilesRoutes.js`: S3-backed uploads, signed URLs, and archive downloads for vendor-facing documents.

### Catalog Uploads, Templates & Bulk Automation
- `routes/catalogupload.js`: Marketplace catalog uploads from S3 with header normalisation and cached marketplace metadata.
- `routes/bulkUploadRoutes.js`: Excel templates and bulk inserts for lots or washing assignments with validation and rollbacks.

### Integrations, Analytics & Partner APIs
- `routes/apiAuthRoutes.js`, `routes/apiRoutes.js`, `routes/productionApiRoutes.js`: JWT-protected APIs for lot retrieval, status updates, and exports.
- `routes/flipkartReturnRoutes.js`, `routes/flipkartIssueStatusRoutes.js`: Flipkart reconciliation for return consignments and issue statuses.
- `routes/easyecomapi.js`, `routes/easyecomRoutes.js`: EasyEcom data ingestion plus stock momentum/runway analytics scoped by warehouse and out-of-stock roles.

### Payments, Challans & Documentation
- `routes/stitchingPaymentRoutes.js`, `routes/washingPaymentRoutes.js`: Rate configuration, payout calculations, and Excel exports for stitching and washing.
- `routes/accountsChallanRoutes.js`, `routes/challanDashboardRoutes.js`: GST challan generation from approved washing assignments with counters, vehicle/purpose metadata, and printable PDFs.

## Connecting the Dots

Procurement teams create parties and POs, indents feed fabric intake, cutting lots drive stitching and assembly, washing and finishing record checkpoints, operators monitor flow health, payroll recalculates as attendance changes, and inventory webhooks trigger out-of-stock alerts that tie back to EasyEcom analytics and store dashboards. Finance teams finish the loop with payments and challans—every step guarded by the same authentication and audit layers.
