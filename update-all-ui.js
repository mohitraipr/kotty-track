const fs = require('fs');
const path = require('path');

// Professional UI Template
const PROFESSIONAL_STYLES = `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', sans-serif; background: #f8f9fa; color: #1e293b; }
  .top-nav { background: white; border-bottom: 1px solid #e2e8f0; padding: 16px 24px; position: sticky; top: 0; z-index: 1000; }
  .nav-brand { font-size: 20px; font-weight: 600; color: #1e293b; }
  .container-main { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .page-title { font-size: 28px; font-weight: 600; color: #1e293b; margin-bottom: 8px; }
  .page-subtitle { font-size: 14px; color: #64748b; margin-bottom: 24px; }
  .card-panel { background: white; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px; }
  .card-header { padding: 20px; border-bottom: 1px solid #e2e8f0; }
  .card-title { font-size: 18px; font-weight: 600; color: #1e293b; margin: 0; }
  .card-body { padding: 20px; }
  .btn-primary { background: #2563eb; border: none; }
  .btn-primary:hover { background: #1d4ed8; }
  .form-label { font-size: 14px; font-weight: 500; color: #475569; }
  .form-control, .form-select { border: 1px solid #e2e8f0; border-radius: 6px; }
  .form-control:focus, .form-select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
  .table { font-size: 14px; }
  .table thead th { background: #f8f9fa; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
  .badge { font-size: 12px; padding: 4px 8px; border-radius: 4px; }
  @media (max-width: 768px) { .container-main { padding: 16px; } }
</style>`;

const PROFESSIONAL_NAV = `<nav class="top-nav">
  <div class="d-flex justify-content-between align-items-center">
    <div class="nav-brand">Kotty Track</div>
    <a href="/" class="btn btn-sm btn-outline-secondary">
      <i class="bi bi-house me-1"></i>Home
    </a>
  </div>
</nav>`;

// List of all view files
const viewsDir = path.join(__dirname, 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs') && !f.includes('partial') && !f.includes('layout'));

console.log(`Found ${files.length} view files to update`);

files.forEach(file => {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Skip if already updated
  if (content.includes('Inter', 'sans-serif')) {
    console.log(`Skipping ${file} (already updated)`);
    return;
  }

  // Update head section
  content = content.replace(
    /<head>[\s\S]*?<\/head>/,
    `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${file.replace('.ejs', '')} - Kotty Track</title>
  ${PROFESSIONAL_STYLES}
</head>`
  );

  // Add navigation if body exists
  if (content.includes('<body>')) {
    content = content.replace('<body>', `<body>\n${PROFESSIONAL_NAV}\n<div class="container-main">`);
    content = content.replace('</body>', '</div></body>');
  }

  // Save updated file
  fs.writeFileSync(filePath, content);
  console.log(`✓ Updated ${file}`);
});

console.log('\n✅ All view files updated with professional UI!');
