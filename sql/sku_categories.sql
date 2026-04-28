-- SKU Categories table for structured SKU building
CREATE TABLE IF NOT EXISTS sku_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_category_name (name)
);

-- Insert default categories
INSERT IGNORE INTO sku_categories (name) VALUES
  ('PANT'),
  ('JEANS'),
  ('SKIRT'),
  ('TOP'),
  ('DRESS'),
  ('SHORTS'),
  ('JACKET'),
  ('SHIRT');
