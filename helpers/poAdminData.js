const crypto = require('crypto');
const { pool } = require('../config/db');

const DEFAULT_MARKETPLACES = [
  {
    name: 'Flipkart',
    masterColumns: ['FSN', 'TITLE', 'MRP', 'STYLECODE', 'COLOR', 'SIZE', 'GENERIC NAME', 'SKU'],
    poColumns: [
      'Product Name',
      'FSN',
      'SKU Id',
      'Brand',
      'Size',
      'Style Code',
      'Color',
      'Isbn',
      'Model Id',
      'Quantity Sent',
      'Quantity Received',
      'Inwarded to Store',
      'QC Fail',
      'QC In Progress',
      'QC Passed',
      'Cost Price',
      'Length(In cms)',
      'Breadth(In cms)',
      'Height(In cms)',
      'Weight(In kgs)',
      'Consignment Number'
    ]
  },
  {
    name: 'Amazon',
    masterColumns: ['SKU', 'ASIN', 'SIZE', 'MRP', 'COLOR', 'STYLE ID', 'TITLE', 'GENERIC NAME', 'Condition'],
    poColumns: [
      'PO+ASIN',
      'PO',
      'Vendor',
      'Ship to location',
      'ASIN',
      'External Id',
      'External Id Type',
      'Model Number',
      'Title',
      'Availability',
      'Window Type',
      'Window start',
      'Window end',
      'Expected date',
      'Quantity Requested',
      'Accepted quantity',
      'Quantity received',
      'Quantity Outstanding',
      'Unit Cost',
      'Total cost'
    ]
  },
  {
    name: 'Myntra',
    masterColumns: [
      'SKU',
      'ARTICLENUMBER',
      'SKUCODE',
      'STYLECODE',
      'Quantity',
      'Size',
      'Color',
      'Warehouse References',
      'MRP',
      'Title'
    ],
    poColumns: [
      'PO NUMBER',
      'SKU Id',
      'Style Id',
      'SKU Code',
      'HSN Code',
      'Brand',
      'GTIN',
      'Vendor Article Number',
      'Vendor Article Name',
      'Size',
      'Colour',
      'Mrp',
      'Credit Period',
      'Margin Type',
      'Agreed Margin',
      'Gross Margin',
      'Quantity',
      'FOB Amount',
      'List price(FOB+Transport-Excise)',
      'Landing Price',
      'Estimated Delivery Date',
      'Tax BCD',
      'Tax BCD Amount',
      'Buying Tax IGST',
      'Buying Tax IGST Amount',
      'Tax SWT',
      'Tax SWT Amount',
      'Selling Tax CGST',
      'Selling Tax CGST Amount',
      'Selling Tax IGST',
      'Selling Tax IGST Amount',
      'Selling Tax SGST',
      'Selling Tax SGST Amount'
    ]
  }
];

const MARKETPLACE_MATCH_RULES = {
  Amazon: { masterKey: 'ASIN', poKey: 'ASIN' },
  Myntra: { masterKey: 'STYLECODE', poKey: 'Style Id' },
  Flipkart: { masterKey: 'FSN', poKey: 'FSN' }
};

function hashAccessKey(accessKey) {
  return crypto.createHash('sha256').update(String(accessKey)).digest('hex');
}

async function ensurePoAdminSetup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_marketplaces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(60) NOT NULL UNIQUE,
      master_columns JSON NOT NULL,
      po_columns JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_master_data (
      id INT AUTO_INCREMENT PRIMARY KEY,
      marketplace_id INT NOT NULL,
      sku VARCHAR(150) NOT NULL,
      data JSON NOT NULL,
      search_blob LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_marketplace_sku (marketplace_id, sku),
      INDEX idx_master_marketplace (marketplace_id),
      CONSTRAINT fk_po_admin_master_marketplace
        FOREIGN KEY (marketplace_id) REFERENCES po_admin_marketplaces(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_po_uploads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      marketplace_id INT NOT NULL,
      data JSON NOT NULL,
      search_blob LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_po_marketplace (marketplace_id),
      CONSTRAINT fk_po_admin_po_marketplace
        FOREIGN KEY (marketplace_id) REFERENCES po_admin_marketplaces(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_api_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      key_name VARCHAR(120) NOT NULL UNIQUE,
      key_hash CHAR(64) NOT NULL UNIQUE,
      key_prefix CHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [[marketplaceCount]] = await pool.query(
    'SELECT COUNT(*) AS count FROM po_admin_marketplaces'
  );

  if (marketplaceCount.count === 0) {
    const values = DEFAULT_MARKETPLACES.map(marketplace => [
      marketplace.name,
      JSON.stringify(marketplace.masterColumns),
      JSON.stringify(marketplace.poColumns)
    ]);
    await pool.query(
      'INSERT INTO po_admin_marketplaces (name, master_columns, po_columns) VALUES ?',
      [values]
    );
  } else {
    const [rows] = await pool.query(
      'SELECT id, name, po_columns AS poColumns FROM po_admin_marketplaces'
    );
    const flipkartRow = rows.find(row => row.name === 'Flipkart');
    if (flipkartRow) {
      const currentColumns = Array.isArray(flipkartRow.poColumns)
        ? flipkartRow.poColumns
        : JSON.parse(flipkartRow.poColumns || '[]');
      if (!currentColumns.includes('Consignment Number')) {
        currentColumns.push('Consignment Number');
        await pool.query(
          'UPDATE po_admin_marketplaces SET po_columns = ? WHERE id = ?',
          [JSON.stringify(currentColumns), flipkartRow.id]
        );
      }
    }
  }
}

async function fetchMarketplaces() {
  const [rows] = await pool.query(
    'SELECT id, name, master_columns AS masterColumns, po_columns AS poColumns FROM po_admin_marketplaces ORDER BY name'
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    masterColumns: Array.isArray(row.masterColumns) ? row.masterColumns : JSON.parse(row.masterColumns || '[]'),
    poColumns: Array.isArray(row.poColumns) ? row.poColumns : JSON.parse(row.poColumns || '[]')
  }));
}

module.exports = {
  DEFAULT_MARKETPLACES,
  MARKETPLACE_MATCH_RULES,
  ensurePoAdminSetup,
  fetchMarketplaces,
  hashAccessKey
};
