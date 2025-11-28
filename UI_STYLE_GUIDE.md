# Kotty Track - UI Style Guide
## Professional Design System Documentation

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Design Philosophy](#design-philosophy)
3. [Color System](#color-system)
4. [Typography](#typography)
5. [Components](#components)
6. [Layout System](#layout-system)
7. [Navigation](#navigation)
8. [Implementation Guide](#implementation-guide)
9. [Best Practices](#best-practices)
10. [Examples](#examples)

---

## 🎨 Overview

The Kotty Track UI is a modern, professional design system built for production management. It provides:

- **Consistent** visual language across all pages
- **Responsive** design that works on all devices
- **Accessible** components that meet WCAG standards
- **Professional** appearance suitable for enterprise use
- **Dark mode** support for user preference
- **Fast** performance with optimized CSS

### Key Features

✅ Modern, clean design
✅ Consistent navigation across all pages
✅ Role-based sidebar menus
✅ Professional color scheme
✅ Responsive on all devices
✅ Dark/Light mode toggle
✅ Smooth animations and transitions
✅ Accessible (WCAG 2.1 compliant)

---

## 💡 Design Philosophy

### Principles

1. **Clarity First** - Information should be easy to find and understand
2. **Consistency** - Same patterns work the same way everywhere
3. **Efficiency** - Minimize clicks and cognitive load
4. **Professionalism** - Enterprise-grade appearance
5. **Accessibility** - Usable by everyone

### Visual Hierarchy

- **Primary** - Main actions and important information
- **Secondary** - Supporting content and alternative actions
- **Tertiary** - Background and supplementary information

---

## 🎨 Color System

### Primary Colors

```css
--primary-color: #2563eb;     /* Primary Blue */
--primary-hover: #1d4ed8;     /* Darker Blue */
--primary-light: #dbeafe;     /* Light Blue */
--primary-dark: #1e40af;      /* Dark Blue */
```

**Usage:**
- Primary buttons, links, active states
- Brand elements, logos
- Important calls-to-action

### Secondary Colors

```css
--secondary-color: #64748b;   /* Slate Gray */
--secondary-hover: #475569;   /* Darker Gray */
--secondary-light: #f1f5f9;   /* Light Gray */
```

**Usage:**
- Secondary buttons
- Less important actions
- Neutral UI elements

### Semantic Colors

```css
--success-color: #10b981;     /* Green */
--warning-color: #f59e0b;     /* Amber */
--danger-color: #ef4444;      /* Red */
--info-color: #06b6d4;        /* Cyan */
```

**Usage:**
- Success: Completed actions, positive feedback
- Warning: Cautions, important notices
- Danger: Errors, destructive actions
- Info: Helpful information, tips

### Neutral Colors

```css
--gray-50 to --gray-900       /* 10 shades of gray */
--text-primary: #111827;      /* Dark text */
--text-secondary: #6b7280;    /* Medium text */
--text-tertiary: #9ca3af;     /* Light text */
```

### Background Colors

```css
--bg-primary: #ffffff;        /* White */
--bg-secondary: #f9fafb;      /* Off-white */
--bg-tertiary: #f3f4f6;       /* Light gray */
--bg-sidebar: #1e293b;        /* Dark sidebar */
```

---

## 📝 Typography

### Font Family

```css
--font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

**Inter** is a modern, highly readable sans-serif font optimized for screens.

### Font Sizes

```css
--font-size-xs: 0.75rem;      /* 12px */
--font-size-sm: 0.875rem;     /* 14px */
--font-size-base: 1rem;       /* 16px */
--font-size-lg: 1.125rem;     /* 18px */
--font-size-xl: 1.25rem;      /* 20px */
--font-size-2xl: 1.5rem;      /* 24px */
--font-size-3xl: 1.875rem;    /* 30px */
--font-size-4xl: 2.25rem;     /* 36px */
```

### Font Weights

- **400** - Regular (body text)
- **500** - Medium (labels, buttons)
- **600** - Semibold (headings)
- **700** - Bold (titles, emphasis)

### Text Hierarchy

```html
<!-- Page Title -->
<h1 class="page-title">Dashboard</h1>

<!-- Section Heading -->
<h2 class="card-title">Recent Activity</h2>

<!-- Subsection -->
<h3 class="sidebar-title">Navigation</h3>

<!-- Body Text -->
<p>Regular paragraph text</p>

<!-- Small Text -->
<span class="text-sm text-secondary">Helper text</span>
```

---

## 🧩 Components

### 1. Buttons

```html
<!-- Primary Button -->
<button class="btn btn-primary">
  <i class="bi bi-plus"></i> Create New
</button>

<!-- Secondary Button -->
<button class="btn btn-secondary">Cancel</button>

<!-- Success Button -->
<button class="btn btn-success">Save</button>

<!-- Danger Button -->
<button class="btn btn-danger">Delete</button>

<!-- Outline Button -->
<button class="btn btn-outline">More Options</button>

<!-- Small Button -->
<button class="btn btn-primary btn-sm">Small</button>

<!-- Large Button -->
<button class="btn btn-primary btn-lg">Large</button>
```

### 2. Cards

```html
<div class="kotty-card">
  <div class="card-header">
    <div>
      <h3 class="card-title">Card Title</h3>
      <p class="card-subtitle">Optional subtitle</p>
    </div>
    <div class="card-actions">
      <button class="btn btn-outline btn-sm">Action</button>
    </div>
  </div>

  <div class="card-body">
    <!-- Card content -->
  </div>

  <div class="card-footer">
    <span class="text-sm text-secondary">Footer text</span>
    <button class="btn btn-primary btn-sm">Action</button>
  </div>
</div>
```

### 3. Statistics Cards

```html
<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-icon">
      <i class="bi bi-box"></i>
    </div>
    <div class="stat-label">Total Lots</div>
    <div class="stat-value">1,234</div>
    <div class="stat-change positive">
      <i class="bi bi-arrow-up"></i> 12.5%
    </div>
  </div>

  <div class="stat-card success">
    <div class="stat-icon">
      <i class="bi bi-check-circle"></i>
    </div>
    <div class="stat-label">Completed</div>
    <div class="stat-value">856</div>
  </div>

  <!-- More stat cards -->
</div>
```

### 4. Tables

```html
<div class="kotty-table-wrapper">
  <table class="kotty-table">
    <thead>
      <tr>
        <th>Lot No</th>
        <th>SKU</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>LOT-001</td>
        <td>SKU-12345</td>
        <td><span class="badge badge-success">Active</span></td>
        <td>
          <button class="btn btn-outline btn-sm">View</button>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

### 5. Badges

```html
<span class="badge badge-primary">Primary</span>
<span class="badge badge-success">Success</span>
<span class="badge badge-warning">Warning</span>
<span class="badge badge-danger">Danger</span>
<span class="badge badge-info">Info</span>
```

### 6. Alerts

```html
<!-- Success Alert -->
<div class="alert alert-success">
  <div class="alert-icon">
    <i class="bi bi-check-circle-fill"></i>
  </div>
  <div class="alert-content">
    <div class="alert-title">Success</div>
    <div>Your changes have been saved.</div>
  </div>
</div>

<!-- Error Alert -->
<div class="alert alert-danger">
  <div class="alert-icon">
    <i class="bi bi-exclamation-triangle-fill"></i>
  </div>
  <div class="alert-content">
    <div class="alert-title">Error</div>
    <div>Something went wrong. Please try again.</div>
  </div>
</div>
```

### 7. Forms

```html
<form>
  <div class="form-group">
    <label class="form-label required">Lot Number</label>
    <input type="text" class="form-control" placeholder="Enter lot number">
    <div class="form-help">This will be used to track your lot</div>
  </div>

  <div class="form-group">
    <label class="form-label">Description</label>
    <textarea class="form-control" rows="4"></textarea>
  </div>

  <div class="form-group">
    <button type="submit" class="btn btn-primary">Submit</button>
    <button type="button" class="btn btn-outline">Cancel</button>
  </div>
</form>
```

---

## 📐 Layout System

### Page Structure

```
┌─────────────────────────────────────────┐
│            NAVBAR (Fixed Top)           │
├──────────┬──────────────────────────────┤
│          │                              │
│ SIDEBAR  │      MAIN CONTENT           │
│ (Fixed)  │      (Scrollable)           │
│          │                              │
│          │                              │
└──────────┴──────────────────────────────┘
```

### Spacing System

```css
--spacing-1: 0.5rem;    /* 8px */
--spacing-2: 1rem;      /* 16px */
--spacing-3: 1.5rem;    /* 24px */
--spacing-4: 2rem;      /* 32px */
--spacing-5: 3rem;      /* 48px */
```

### Border Radius

```css
--radius-sm: 0.375rem;  /* 6px */
--radius-md: 0.5rem;    /* 8px */
--radius-lg: 0.75rem;   /* 12px */
--radius-xl: 1rem;      /* 16px */
--radius-2xl: 1.5rem;   /* 24px */
--radius-full: 9999px;  /* Fully rounded */
```

---

## 🧭 Navigation

### Navbar

- **Fixed** at top of page
- **64px** height
- Dark gradient background
- Contains:
  - Brand logo & name
  - Mobile menu toggle
  - Theme toggle
  - User menu
  - Logout button

### Sidebar

- **Fixed** on left side
- **260px** wide (collapsed: **72px**)
- Role-based menu items
- Active state highlighting
- Collapsible on mobile
- Auto-collapses on small screens

### Mobile Navigation

- **Hamburger menu** on mobile
- **Overlay** backdrop
- **Slide-in** sidebar
- **Touch-friendly** targets (min 44px)

---

## 🛠️ Implementation Guide

### Option 1: Using Master Layout (Recommended)

```ejs
<!-- Example: operatorDashboard.ejs -->
<%
  // Define page-specific variables
  const pageTitle = "Dashboard";
  const dashboardUrl = "/operator/dashboard";
  const additionalCSS = [];
  const additionalJS = ['/js/dashboard.js'];
%>

<%- include('layouts/master', {
  pageTitle,
  user,
  dashboardUrl,
  additionalCSS,
  additionalJS,
  body: `
    <!-- Page Header -->
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <p class="page-subtitle">Welcome back, ${user.username}</p>

      <div class="page-actions">
        <button class="btn btn-primary">
          <i class="bi bi-plus"></i> New Lot
        </button>
      </div>
    </div>

    <!-- Statistics Grid -->
    <div class="stats-grid">
      <!-- Stat cards here -->
    </div>

    <!-- Main Content -->
    <div class="kotty-card">
      <!-- Card content -->
    </div>
  `
}) %>
```

### Option 2: Manual Implementation

```ejs
<%- include('partials/header', { pageTitle: 'Dashboard' }) %>
<%- include('partials/navbar', { user, dashboardUrl: '/operator/dashboard' }) %>
<%- include('partials/sidebar', { user, req }) %>

<main class="kotty-main">
  <div class="content-wrapper">
    <%- include('partials/flashMessages') %>

    <!-- Your page content -->

  </div>
</main>

<%- include('partials/footer') %>
```

---

## ✅ Best Practices

### 1. Consistent Spacing

```css
/* Good - Using design system variables */
.my-component {
  margin-bottom: var(--spacing-3);
  padding: var(--spacing-2);
}

/* Bad - Magic numbers */
.my-component {
  margin-bottom: 23px;
  padding: 17px;
}
```

### 2. Color Usage

```css
/* Good - Semantic colors */
.success-message {
  color: var(--success-color);
}

/* Bad - Direct hex codes */
.success-message {
  color: #10b981;
}
```

### 3. Button Hierarchy

- **Primary** - Main action (1 per section)
- **Secondary** - Alternative actions
- **Outline** - Tertiary actions
- **Danger** - Destructive actions (with confirmation)

### 4. Responsive Design

```css
/* Mobile First Approach */
.component {
  /* Mobile styles (default) */
  padding: 1rem;
}

@media (min-width: 768px) {
  /* Tablet and up */
  .component {
    padding: 2rem;
  }
}

@media (min-width: 1024px) {
  /* Desktop and up */
  .component {
    padding: 3rem;
  }
}
```

### 5. Accessibility

- ✅ All interactive elements have **min 44x44px** touch target
- ✅ Color contrast ratio **4.5:1** for text
- ✅ All form inputs have **labels**
- ✅ Keyboard navigation works
- ✅ Screen reader friendly
- ✅ Focus indicators visible

---

## 📖 Examples

### Complete Page Example

```ejs
<%
  const pageTitle = "Stitching Dashboard";
  const dashboardUrl = "/stitchingdashboard";
%>

<%- include('partials/header', { pageTitle }) %>
<%- include('partials/navbar', { user, dashboardUrl }) %>
<%- include('partials/sidebar', { user, req }) %>

<main class="kotty-main">
  <div class="content-wrapper">

    <%- include('partials/flashMessages') %>

    <!-- Page Header -->
    <div class="page-header">
      <h1 class="page-title">Stitching Dashboard</h1>
      <p class="page-subtitle">Manage your stitching operations</p>

      <div class="page-actions">
        <button class="btn btn-outline">
          <i class="bi bi-funnel"></i> Filter
        </button>
        <button class="btn btn-primary">
          <i class="bi bi-plus"></i> New Entry
        </button>
      </div>
    </div>

    <!-- Statistics -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">
          <i class="bi bi-box"></i>
        </div>
        <div class="stat-label">Total Assignments</div>
        <div class="stat-value">124</div>
        <div class="stat-change positive">
          <i class="bi bi-arrow-up"></i> 5.2%
        </div>
      </div>

      <div class="stat-card success">
        <div class="stat-icon">
          <i class="bi bi-check-circle"></i>
        </div>
        <div class="stat-label">Approved</div>
        <div class="stat-value">98</div>
      </div>

      <div class="stat-card warning">
        <div class="stat-icon">
          <i class="bi bi-clock"></i>
        </div>
        <div class="stat-label">Pending</div>
        <div class="stat-value">26</div>
      </div>
    </div>

    <!-- Data Table -->
    <div class="kotty-card">
      <div class="card-header">
        <h3 class="card-title">Recent Entries</h3>
        <div class="card-actions">
          <button class="btn btn-outline btn-sm">
            <i class="bi bi-download"></i> Export
          </button>
        </div>
      </div>

      <div class="card-body">
        <div class="kotty-table-wrapper">
          <table class="kotty-table">
            <thead>
              <tr>
                <th>Lot No</th>
                <th>SKU</th>
                <th>Pieces</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>LOT-001</td>
                <td>SKU-12345</td>
                <td>500</td>
                <td><span class="badge badge-success">Approved</span></td>
                <td>
                  <button class="btn btn-outline btn-sm">View</button>
                </td>
              </tr>
              <!-- More rows -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>
</main>

<%- include('partials/footer') %>
```

---

## 🎯 Dark Mode

Dark mode is automatically available via the theme toggle in the navbar.

### CSS Variables (Dark Mode)

```css
[data-theme="dark"] {
  --bg-primary: #1e293b;
  --bg-secondary: #0f172a;
  --text-primary: #f1f5f9;
  --text-secondary: #cbd5e1;
  /* ... other dark mode variables */
}
```

### Implementation

The theme is stored in `localStorage` and persists across sessions.

```javascript
// Toggle theme
const html = document.documentElement;
const currentTheme = html.getAttribute('data-theme');
const newTheme = currentTheme === 'light' ? 'dark' : 'light';
html.setAttribute('data-theme', newTheme);
localStorage.setItem('theme', newTheme);
```

---

## 📱 Responsive Breakpoints

```css
/* Mobile First */
/* Default: 0-767px (Mobile) */

@media (min-width: 768px) {
  /* Tablet: 768px-1023px */
}

@media (min-width: 1024px) {
  /* Desktop: 1024px-1279px */
}

@media (min-width: 1280px) {
  /* Large Desktop: 1280px+ */
}
```

---

## 🔧 File Structure

```
kotty-track/
├── public/
│   └── css/
│       └── kotty-theme.css         # Main theme file
├── views/
│   ├── layouts/
│   │   └── master.ejs              # Master layout template
│   ├── partials/
│   │   ├── header.ejs              # HTML head
│   │   ├── navbar.ejs              # Top navigation
│   │   ├── sidebar.ejs             # Side navigation
│   │   ├── footer.ejs              # Scripts & closing tags
│   │   └── flashMessages.ejs       # Alert messages
│   ├── login-new.ejs               # Updated login page
│   └── [role]Dashboard.ejs         # Page templates
└── UI_STYLE_GUIDE.md               # This file
```

---

## 🚀 Getting Started

### 1. Link CSS File

Make sure `/css/kotty-theme.css` is accessible:

```bash
# Ensure public folder is served as static
app.use(express.static('public'));
```

### 2. Use Master Layout

Update your views to use the new layout:

```ejs
<%- include('partials/header', { pageTitle: 'My Page' }) %>
<%- include('partials/navbar', { user, dashboardUrl: '/dashboard' }) %>
<%- include('partials/sidebar', { user, req }) %>

<main class="kotty-main">
  <!-- Your content -->
</main>

<%- include('partials/footer') %>
```

### 3. Apply Components

Use the design system components in your pages:

```html
<div class="kotty-card">
  <div class="card-header">
    <h3 class="card-title">Title</h3>
  </div>
  <div class="card-body">
    Content
  </div>
</div>
```

---

## 📞 Support & Questions

For questions or suggestions about the UI system:

1. Check this style guide first
2. Review `/public/css/kotty-theme.css` for available classes
3. Look at example pages in `/views/`
4. Contact the development team

---

**Version:** 2.0
**Last Updated:** 2025-11-29
**Maintained By:** Kotty Track Development Team

---

## 🎉 Summary

The Kotty Track UI system provides:

✅ **Professional** enterprise-grade design
✅ **Consistent** components and patterns
✅ **Responsive** mobile-first layouts
✅ **Accessible** WCAG 2.1 compliant
✅ **Themeable** dark/light mode support
✅ **Maintainable** centralized design system
✅ **Documented** comprehensive style guide

Use this guide as your reference for all UI implementation!
