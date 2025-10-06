const express = require('express');
const router = express.Router();

const featureSections = [
  {
    id: 'auth',
    title: 'Authentication & Access Control',
    description:
      'Secure entry points ensure every workflow starts with the right user context and permissions.',
    highlights: [
      'Credential validation with bcrypt checks and active user gating on the login form.',
      'Automatic redirection to the appropriate role dashboard after login so teams land where they work most.',
      'Session-backed guards and role-based middleware applied across routes to prevent unauthorised access.'
    ]
  },
  {
    id: 'admin',
    title: 'Administrative Control Center',
    description:
      'Platform administrators can shape roles, dashboards, and accounts without touching the database directly.',
    highlights: [
      'Manage role definitions, user creation, password resets, and account deactivation with full audit logging.',
      'Spin up new dashboards by defining backing tables and selectable update permissions in a single form.',
      'Review the latest audit events to keep a trail of structural and account level changes.'
    ]
  },
  {
    id: 'dashboards',
    title: 'Role-Specific Dashboards',
    description:
      'Dynamic dashboards turn database tables into searchable, paginated workspaces tailored to each role.',
    highlights: [
      'List the dashboards available to the signed-in role with a click-through data grid for each table.',
      'Search across any column, filter by owner, paginate large datasets, and export precise slices to Excel.',
      'Insert single records or perform authenticated bulk uploads with automatic date conversion and ownership tagging.'
    ]
  },
  {
    id: 'fabric',
    title: 'Fabric Procurement Tracking',
    description:
      'Fabric managers follow invoices from vendor onboarding through roll-level intake and bulk ingestion.',
    highlights: [
      'Paginated invoice views combine vendor metadata, receipt dates, and weight differentials.',
      'Single-entry forms capture invoices or roll breakdowns with validation, vendor caching, and automatic associations.',
      'Excel imports speed up invoice and roll onboarding, normalising Excel serial dates before persistence.'
    ]
  },
  {
    id: 'cutting',
    title: 'Cutting Management',
    description:
      'Cutting managers control lot creation, assignment, and documentation from one workspace.',
    highlights: [
      'Generate sequential lot numbers, record SKU-specific piece counts, attach reference images, and review recent lots.',
      'View lot details with consolidated size breakdowns and create PDF challans for downstream departments.',
      'Assign approved lots to stitching teams individually or through Excel-driven bulk uploads.'
    ]
  },
  {
    id: 'stitching',
    title: 'Stitching Operations & Payments',
    description:
      'Stitching masters progress lots, keep approvals moving, and reconcile payouts from one module.',
    highlights: [
      'Approve or deny assignments with remarks, then capture stitched quantities, size splits, and photo evidence.',
      'Amend or download stitched records, generate challans, and stream consolidated exports for reporting.',
      'Settle compensation with contract- or operation-wise payment screens that pull live rates per SKU or task.'
    ]
  },
  {
    id: 'assembly',
    title: 'Jeans Assembly Workflow',
    description:
      'Assembly teams finalise stitched lots, manage approvals, and prepare washing handovers.',
    highlights: [
      'Create assembly records with per-size quantities, remarks, and optional imagery tied to stitching outputs.',
      'Update or audit past records, generate challans, and download portfolio-wide Excel snapshots.',
      'Process assignment approvals so only validated lots move into washing pipelines.'
    ]
  },
  {
    id: 'washing',
    title: 'Washing Lifecycle',
    description:
      'From washer approvals to rewash loops, the washing modules keep every batch accounted for.',
    highlights: [
      'Approve washer assignments, capture washed quantities per size, attach images, and avoid duplicate lot submissions.',
      'Allow washing-in leads to validate inbound loads, split pieces towards finishing or rewash, and generate challans or Excel exports.',
      'Maintain washer rate cards, build invoices, and provide individuals with self-serve invoice histories.'
    ]
  },
  {
    id: 'finishing',
    title: 'Finishing & Dispatch',
    description:
      'Finishing masters close the production loop and orchestrate dispatch directly from the system.',
    highlights: [
      'Create finishing entries against approved washing assignments with size validation and photo capture.',
      'Approve, deny, or edit finishing records, generate challans, and emit ready-to-ship dispatch notices.',
      'Dispatch partial or full loads, upload bulk dispatch sheets, and download templates for repeat workflows.'
    ]
  },
  {
    id: 'operator',
    title: 'Operator Control Room',
    description:
      'Operators gain a bird’s-eye view of production health while managing people, assignments, and pay.',
    highlights: [
      'Track stitched, washed, and finished totals with conversion analytics, SKU trends, and turnaround metrics.',
      'Search any production table with column selection, cached results, and instant Excel exports.',
      'Manage departments, supervisors, and workers – including salary uploads, incentives, advances, and washing assignments.'
    ]
  },
  {
    id: 'quality',
    title: 'Quality & Department Assurance',
    description:
      'Quality and checking teams confirm production stages and keep backlog visibility clear.',
    highlights: [
      'Review outstanding lots per department with drill-downs into piece balances and assignment history.',
      'Confirm received quantities to release lots forward, ensuring accountability between hand-offs.'
    ]
  },
  {
    id: 'inventory',
    title: 'Inventory & Store Management',
    description:
      'Store admins, floor staff, and automated integrations keep stock counts synchronised.',
    highlights: [
      'Record store receipts, generate internal vouchers, and monitor dispatch history with Excel exports.',
      'Track incoming and outgoing inventory transactions, trigger low-stock alerts, and review SKU thresholds.',
      'Accept EasyEcom webhook feeds, broadcast live inventory alerts via server-sent events, and manage push subscriptions.'
    ]
  },
  {
    id: 'accounts',
    title: 'Accounts & Procurement',
    description:
      'Accounts teams maintain master data for vendors and factories without leaving the app.',
    highlights: [
      'List purchase parties and partner factories with inline creation and updates.',
      'Download import templates and bulk upload Excel sheets to speed up master data maintenance.'
    ]
  },
  {
    id: 'integrations',
    title: 'External Integrations & APIs',
    description:
      'The platform ties into partner systems to keep service and data flows aligned.',
    highlights: [
      'Retrieve Flipkart courier returns directly through authenticated API calls for quick reconciliation.',
      'Check Flipkart case statuses with seller-authenticated lookups for escalated tickets.',
      'Expose fabric roll availability through authenticated APIs for downstream tooling.'
    ]
  },
  {
    id: 'challans',
    title: 'Challan & Documentation Hub',
    description:
      'Centralised challan tooling speeds up documentation across departments.',
    highlights: [
      'Search historical challans, clone data into new documents, and generate printable PDFs.',
      'Create new challans with granular item rows and surface them to relevant dashboards.'
    ]
  }
];

router.get('/features', (req, res) => {
  res.render('features', {
    user: req.session?.user || null,
    featureSections
  });
});

module.exports = router;
