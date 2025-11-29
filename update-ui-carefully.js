const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'views');

// Function to add professional.css to a file if not already present
function addProfessionalCSS(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Skip if already has professional.css
  if (content.includes('professional.css')) {
    console.log(`✓ Already updated: ${path.basename(filePath)}`);
    return false;
  }

  // Skip if doesn't have <head> tag
  if (!content.includes('<head>')) {
    console.log(`⊘ Skipping (no <head>): ${path.basename(filePath)}`);
    return false;
  }

  // Add Inter font if not present
  if (!content.includes('fonts.googleapis.com/css2?family=Inter')) {
    const interLink = `  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">\n`;
    content = content.replace('</head>', `${interLink}</head>`);
  }

  // Add professional.css before </head>
  const professionalLink = `  <link rel="stylesheet" href="/css/professional.css">\n`;
  content = content.replace('</head>', `${professionalLink}</head>`);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Updated: ${path.basename(filePath)}`);
  return true;
}

// Get all EJS files
function getAllEJSFiles(dir) {
  let results = [];
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip node_modules and other non-view directories
      if (!['node_modules', '.git', 'public'].includes(item)) {
        results = results.concat(getAllEJSFiles(fullPath));
      }
    } else if (item.endsWith('.ejs')) {
      results.push(fullPath);
    }
  }

  return results;
}

console.log('🚀 Starting UI update - Adding professional.css to all views...\n');

const allFiles = getAllEJSFiles(viewsDir);
let updatedCount = 0;

for (const file of allFiles) {
  if (addProfessionalCSS(file)) {
    updatedCount++;
  }
}

console.log(`\n✅ Complete! Updated ${updatedCount} files.`);
