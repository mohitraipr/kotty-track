-- SQL schema for washing payment invoices
CREATE TABLE washing_invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  washer_id INT NOT NULL,
  operator_id INT NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  invoice_url VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE washing_invoice_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  washing_data_id INT NOT NULL,
  lot_no VARCHAR(100),
  description VARCHAR(100),
  qty INT,
  rate DECIMAL(10,2),
  amount DECIMAL(10,2),
  FOREIGN KEY (invoice_id) REFERENCES washing_invoices(id)
);
