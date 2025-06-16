# kotty-track

## Database Updates

To support configurable working hours per employee, run the following SQL against your database:

```sql
ALTER TABLE employees
  ADD COLUMN working_hours DECIMAL(5,2) NOT NULL DEFAULT 8;

CREATE TABLE IF NOT EXISTS employee_daily_hours (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  hours_worked DECIMAL(5,2) NOT NULL,
  punch_in TIME NULL,
  punch_out TIME NULL,
  UNIQUE KEY uniq_emp_day (employee_id, work_date)
);
```

`employee_daily_hours` records how many hours an employee worked on a given day along with the first punch in time and last punch out time. Later you can calculate under time or overtime by comparing `hours_worked` with the employee's `working_hours`.

To track which supervisor created each employee, add a `created_by` column:

```sql
ALTER TABLE employees
  ADD COLUMN created_by INT NOT NULL,
  ADD CONSTRAINT fk_employee_creator FOREIGN KEY (created_by) REFERENCES users(id);
```

This column stores the user ID of the supervisor who created the employee.

### Allow same punching IDs for different supervisors

Originally the `employees` table enforced a global unique constraint on
`punching_id`. When multiple supervisors manage their own employees this
restriction causes conflicts because the same punching ID can legitimately
exist in different supervisor groups. The application now checks uniqueness per
supervisor, so update the database accordingly:

```sql
ALTER TABLE employees
  DROP INDEX punching_id,
  ADD UNIQUE KEY uniq_supervisor_punch (punching_id, created_by);
```

The index name `punching_id` comes from the original schema. After dropping it
we create a composite unique index on `(punching_id, created_by)` so each
supervisor can reuse punching IDs without clashes.

### Sunday tracking and paid leave

To support rules around Sunday work and paid leave balances, add these columns:

```sql
ALTER TABLE employees
  ADD COLUMN pays_sunday TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN paid_leave_balance DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE employee_daily_hours
  ADD COLUMN is_sunday TINYINT(1) NOT NULL DEFAULT 0;
```

`pays_sunday` indicates whether an employee receives regular salary for Sundays.
Each record in `employee_daily_hours` now stores whether the date was a Sunday
via the `is_sunday` column, enabling future salary rules like the sandwich rule
and Sunday deductions.

### Financial tracking

Employees now track advances, debits, and night shifts. Add these columns:

```sql
ALTER TABLE employees
  ADD COLUMN advance_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN debit_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN nights_worked INT NOT NULL DEFAULT 0;
```

`advance_balance` and `debit_balance` store outstanding amounts that will be deducted from salary.
`nights_worked` counts how many night shifts were performed in the current period and can be edited by supervisors.

### Night allowance

Each night shift pays an additional allowance calculated as the employee's monthly salary divided by the number of days in that month. For example, an employee earning ₹12,000 in a 30-day month receives ₹400 for every night worked.

## Inventory Management

Create the following tables for the store employee dashboard:

```sql
CREATE TABLE goods_inventory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  description_of_goods VARCHAR(255) NOT NULL,
  size VARCHAR(50) NOT NULL,
  unit ENUM('PCS','ROLL') NOT NULL,
  qty INT NOT NULL DEFAULT 0
);

INSERT INTO goods_inventory (description_of_goods, size, unit)
VALUES
  ('FLIPKART POLYBAG', '10*13', 'PCS'),
  ('FLIPKART POLYBAG', '12.5*14', 'PCS'),
  ('FLIPKART POLYBAG', '16*20', 'PCS'),
  ('MYNTRA PAPER BAG', '13*15', 'PCS'),
  ('MYNTRA PAPER BAG', '15*18', 'PCS'),
  ('MYNTRA PAPER BAG', '17*21', 'PCS'),
  ('NYKAA PAPER BAG', '13*15', 'PCS'),
  ('NYKAA PAPER BAG', '10*12', 'PCS'),
  ('TRANPARENT POLYBAG', '8*9*2', 'PCS'),
  ('TRANPARENT POLYBAG', '10*12*2', 'PCS'),
  ('TRANPARENT POLYBAG', '12*13*2', 'PCS'),
  ('TRANPARENT POLYBAG', '11*14*2', 'PCS'),
  ('TRANPARENT POLYBAG', '12*16*2', 'PCS'),
  ('TRANPARENT POLYBAG', '14*24*2', 'PCS'),
  ('AMAZON POLYBAG NP6', '10*14', 'PCS'),
  ('AMAZON POLYBAG NP7', '12*16', 'PCS'),
  ('AMAZON PLAIN POLYBAG NP6', '10*14', 'PCS'),
  ('AMAZON PLAIN POLYBAG NP7', '12*16', 'PCS'),
  ('AJIO POLYBAG', '10*14', 'PCS'),
  ('AJIO POLYBAG', '12*16', 'PCS'),
  ('AJIO POLYBAG', '16*20', 'PCS'),
  ('BARCODE ROLL', '38*50', 'ROLL'),
  ('BARCODE ROLL', '75*50', 'ROLL'),
  ('WATER MARK 3*5', '75*125', 'ROLL'),
  ('BARCODE ROLL', '100*150', 'ROLL'),
  ('RIBBON', '80*300', 'ROLL'),
  ('RIBBON', '40*225', 'ROLL'),
  ('TAFTA ROLL', '', 'ROLL');

CREATE TABLE incoming_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  goods_id INT NOT NULL,
  quantity INT NOT NULL,
  added_by INT NOT NULL,
  remark VARCHAR(255),
  added_at DATETIME NOT NULL,
  FOREIGN KEY (goods_id) REFERENCES goods_inventory(id)
);

CREATE TABLE dispatched_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  goods_id INT NOT NULL,
  quantity INT NOT NULL,
  remark VARCHAR(255),
  dispatched_by INT NOT NULL,
  dispatched_at DATETIME NOT NULL,
  FOREIGN KEY (goods_id) REFERENCES goods_inventory(id)
);
```

`incoming_data` stores every addition with timestamp and user while `dispatched_data` tracks quantity sent out along with remarks.
