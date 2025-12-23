CREATE TABLE po_sku_vendor_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(64) NOT NULL UNIQUE,
  vendor_code VARCHAR(64) NOT NULL,
  color VARCHAR(64),
  image_url TEXT,
  weight DECIMAL(10, 3),
  link TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE po_vendor_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE po_vendor_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  vendor_code VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES po_vendor_batches(id)
);

CREATE TABLE po_vendor_order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  sku VARCHAR(64) NOT NULL,
  product_size VARCHAR(32) NOT NULL,
  quantity INT NOT NULL,
  color VARCHAR(64),
  image_url TEXT,
  weight DECIMAL(10, 3),
  link TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES po_vendor_orders(id)
);
