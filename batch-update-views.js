#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'views');

// Files to skip
const skip = ['partials', 'layouts', 'login.ejs', 'operatorDashboard.ejs', 'operatorPICReport.ejs', 'operatorSizeReport.ejs'];

// Professional head template
const professionalHead = `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/professional.css">`;

// Simple navigation
const simpleNav = `  <nav class="top-nav">
    <div class="d-flex justify-content-between align-items-center">
      <a href="/" class="nav-brand" style="text-decoration: none;">Kotty Track</a>
      <div>
        <a href="/" class="btn btn-sm btn-outline-secondary me-2">
          <i class="bi bi-house me-1"></i>Home
        </a>
        <a href="/logout" class="btn btn-sm btn-outline-secondary">
          <i class="bi bi-box-arrow-right me-1"></i>Logout
        </a>
      </div>
    </div>
  </nav>\n`;

function updateFile(filePath, fileName) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');

    // Skip if already has professional.css
    if (content.includes('/css/professional.css')) {
      console.log(`⏭  Skip: ${fileName} (already updated)`);
      return;
    }

    // Ensure Inter font
    if (!content.includes('Inter')) {
      // Add professional CSS before </head>
      if (content.includes('</head>')) {
        content = content.replace('</head>', `  ${professionalHead}\n</head>`);
      }
    }

    // Add navigation after <body> if not present
    if (!content.includes('top-nav') && !content.includes('navbar') && content.includes('<body>')) {
      content = content.replace(/<body([^>]*)>/, `<body$1>\n${simpleNav}`);
    }

    // Wrap content in container-main if not present
    if (!content.includes('container-main') && !content.includes('container-fluid')) {
      const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/);
      if (bodyMatch) {
        const bodyContent = bodyMatch[1];
        // Only wrap if doesn't already have a container
        if (!bodyContent.trim().startsWith('<div class="container')) {
          const wrappedContent = bodyContent.replace(
            /<body[^>]*>/,
            '<body>\n<div class="container-main">\n'
          ).replace('</body>', '\n</div>\n</body>');
          content = content.replace(bodyMatch[0], wrappedContent);
        }
      }
    }

    // Save updated file
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Updated: ${fileName}`);
  } catch (error) {
    console.error(`✗ Error updating ${fileName}:`, error.message);
  }
}

function processDirectory(dir) {
  const items = fs.readdirSync(dir);

  items.forEach(item => {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!skip.some(s => item.includes(s))) {
        processDirectory(fullPath);
      }
    } else if (item.endsWith('.ejs')) {
      if (!skip.some(s => item === s)) {
        updateFile(fullPath, item);
      }
    }
  });
}

console.log('🚀 Starting batch update of all view files...\n');
processDirectory(viewsDir);
console.log('\n✅ Batch update complete!');
console.log('\n📝 Next steps:');
console.log('   1. Review the changes: git diff');
console.log('   2. Test the application');
console.log('   3. Commit: git add -A && git commit -m "Apply professional UI to all pages"');
