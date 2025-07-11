# Kotty Track

Kotty Track is a Node.js and Express application used to manage the production workflow and employee operations of a garment unit.  It features role based dashboards for administrators, operators, supervisors and store staff.  Data is stored in MySQL and views are rendered using EJS templates.

## Features

- **Authentication** – Users log in and are redirected to dashboards based on their role.
- **Admin tools** – Manage roles, users and dynamically create dashboard tables.
- **Production workflow** – Routes exist for fabric, cutting, stitching, finishing, washing and jeans assembly managers.
- **Employee management** – Supervisors register employees, record attendance, handle salary calculations and upload night shift data.
- **Store inventory** – Store admins maintain the list of goods while store employees add incoming stock and record dispatches.
- **Bulk upload & search** – Operators can upload attendance files and perform bulk updates; Excel exports are available throughout the system.
- **Supervisor cleanup** – Operators can remove a supervisor's employees and all related records in one action.
- **Audit logging** – Important actions are written to log files for later review.

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file with your database and session details and encrypt it using [secure-env](https://www.npmjs.com/package/secure-env):
   ```bash
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=myuser
   DB_PASSWORD=mypassword
   DB_NAME=kotty
   SESSION_SECRET=your-session-secret
   PORT=3000
   NODE_ENV=development
   # Token used to validate EasyEcom webhooks
   EASYEECOM_ACCESS_TOKEN=your-easyecom-token
  ```
   Encrypt the file:
   ```bash
   npx secure-env .env -s mySecretPassword
   ```
   The generated `env.enc` must remain in the project root.
3. Create the MySQL schema using the statements described below.

## Running the Application

Start the server with:
```bash
npm start
```
The application listens on the port specified by `PORT` (default `3000`).

## Database Schema

Below are the tables used by the application.  Run these statements in your MySQL database before starting the server.

### Inventory Management

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

Create a table to persist inventory alerts triggered by the webhook:
```sql
CREATE TABLE inventory_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(255) NOT NULL,
  quantity INT NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE push_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
);

CREATE TABLE sku_thresholds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(255) NOT NULL UNIQUE,
  threshold INT NOT NULL
);
```

`inventory_alerts` stores each threshold breach so operators can review past
events. `push_subscriptions` holds browser push registration data for users
who have allowed notifications. `sku_thresholds` keeps the threshold for each
SKU so webhook alerts survive server restarts.

Create a `store_admin` role in the `roles` table to allow managing the list of goods. Users with this role can add new items (description, size and unit) from the Store Admin dashboard. Newly created items automatically appear in the store inventory pages.

### Department & Supervisor Tables

Use the following tables to manage departments and the supervisors assigned to them:
```sql
CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE department_supervisors (
  department_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (department_id, user_id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```
Operators can create departments and assign `supervisor` users to them from the Department Management screen.

### Supervisor Employees

To let supervisors manage their own employees, create the following table:
```sql
CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id INT NOT NULL,
  punching_id VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  designation VARCHAR(100),
  phone_number VARCHAR(20),
  salary DECIMAL(10,2) NOT NULL,
  salary_type ENUM('dihadi', 'monthly') NOT NULL,
  paid_sunday_allowance INT NOT NULL DEFAULT 0,
  date_of_joining DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uniq_supervisor_punch (supervisor_id, punching_id),
  FOREIGN KEY (supervisor_id) REFERENCES users(id)
);
```
Each supervisor must assign unique punching IDs to their employees. This ensures no duplicate entries. Employees earn leave and salary details stored in `employee_salaries`. These actions are available from the operator dashboard, which also lists each supervisor with their active employee count and total monthly salary.

### Employee Leaves

Supervisors can track leaves for their employees using this table:
```sql
CREATE TABLE employee_leaves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  leave_date DATE NOT NULL,
  days DECIMAL(4,2) NOT NULL,
  remark VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
```
Employees earn 1.5 days of leave after completing three months of service and accrue 1.5 days each month thereafter.
Daily wage (`dihadi`) workers are paid only for hours worked and do not accumulate leaves.

### Employee Debits & Advances

Supervisors may record financial debits or advances for their employees. Use separate tables linked to the employee:
```sql
CREATE TABLE employee_debits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(255),
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE employee_advances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(255),
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE advance_deductions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  month CHAR(7) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
```
Debits represent losses caused by the employee, while advances are company funds lent to them.
Any deduction of an advance from a salary is logged in the `advance_deductions` table with the month it was applied.

Advance deductions always apply to the latest salary entry for an employee. If salaries are uploaded for half-month periods (e.g. only the first or second 15 days), the deduction is still linked to that month and can be recorded only once per entry.


Advance deductions always apply to the latest salary entry for an employee. If salaries are uploaded for half-month periods (e.g. only the first or second 15 days), the deduction is still linked to that month and can be recorded only once per entry.


Advance deductions always apply to the latest salary entry for an employee. If salaries are uploaded for half-month periods (e.g. only the first or second 15 days), the deduction is still linked to that month and can be recorded only once per entry.



### Attendance & Salary

Add tables to track daily attendance and calculate monthly salaries:
```sql
CREATE TABLE employee_attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  date DATE NOT NULL,
  punch_in TIME,
  punch_out TIME,
  status ENUM('present','absent','one punch only') DEFAULT 'present',
  UNIQUE KEY unique_att (employee_id, date),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE employee_salaries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  month CHAR(7) NOT NULL, -- YYYY-MM
  gross DECIMAL(10,2) NOT NULL,
  deduction DECIMAL(10,2) NOT NULL,
  net DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY unique_salary (employee_id, month),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
```
Update the `employees` table to store each worker's allotted hours per day:
```sql
ALTER TABLE employees ADD COLUMN allotted_hours DECIMAL(4,2) NOT NULL DEFAULT 0;
```

Lunch breaks are deducted from recorded hours only for workers paid on a `dihadi` (daily wage) basis. Monthly salary employees keep their full punch duration.

`dihadi` workers do not receive any special treatment for Sundays. Their pay is purely based on hours worked.

Punching in after **09:15** results in an additional one-hour deduction from the day's counted hours for **dihadi** (daily wage) employees only.

### Sunday Attendance Rules

- **Special departments (`catalog`, `account`, `merchant`)** – Sundays never grant extra pay; any worked Sunday is credited as leave.
- **All other departments** – a Sunday is paid only when the employee works that day and has unused `paid_sunday_allowance`. Otherwise the day is credited as leave.

Employees receive Sunday pay only when they have valid punch in/out times with positive working hours.

These credited days are automatically inserted into `employee_leaves` during salary calculations.
For most teams, a Sunday becomes unpaid whenever the employee is absent on the adjacent Saturday or Monday. If both days are missed, all three (Saturday–Sunday–Monday) are deducted from salary. Teams supervised by **Rohit Shukla** follow the old rule where Sunday counts only when Saturday *and* Monday are absent. When the employee works on that Sunday, any adjacent absence is paid as usual.

### Attendance Edit Logs

Operators can adjust an employee's punch in/out times. A log table tracks these updates and limits each employee to thirty-five edits total:
```sql
CREATE TABLE attendance_edit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  attendance_date DATE NOT NULL,
  old_punch_in TIME,
  old_punch_out TIME,
  new_punch_in TIME,
  new_punch_out TIME,
  operator_id INT NOT NULL,
  edited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (operator_id) REFERENCES users(id)
);
```
Operators can modify punch times from the dashboard, but once thirty-five rows exist in `attendance_edit_logs` for an employee no further edits are allowed. Every update recalculates the employee's salary for that month.

### Attendance Edit Routes

Several endpoints update attendance records and then recalculate salary using
`helpers/salaryCalculator.js`:

- `POST /operator/employees/:id/edit` – update a single day of attendance
  for one employee.
- `POST /operator/supervisors/:id/bulk-attendance` – bulk edit a specific date
  for all employees under a supervisor.
- `POST /operator/employees/:id/bulk-attendance` – edit an entire month of
  attendance for one employee.
- `POST /departments/fix-miss-punch` – automatically correct "one punch only"
  entries for a single employee.
- `POST /departments/bulk-fix-miss-punch` – upload an Excel file to fix many
  employees at once.

Each of these routes calls `calculateSalaryForMonth` after saving attendance so
that both monthly and dihadi salaries are updated with any advance deductions.

### Night Shift Uploads

Operators can upload a monthly Excel sheet listing the night shifts worked by employees. Create a table to store these uploads:
```sql
CREATE TABLE employee_nights (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  supervisor_name VARCHAR(100) NOT NULL,
  supervisor_department VARCHAR(100) NOT NULL,
  punching_id VARCHAR(100) NOT NULL,
  employee_name VARCHAR(100) NOT NULL,
  nights INT NOT NULL,
  month CHAR(7) NOT NULL,
  UNIQUE KEY uniq_night (employee_id, month),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
```
Uploading a sheet increases the employee's salary by `nights * (salary / days_in_month)` for the specified month. Duplicate uploads for the same employee and month are ignored. Operators can download an Excel template via the `/salary/night-template` route. The file includes the columns `supervisorname`, `supervisordepartment`, `punchingid`, `name`, `nights`, `month`.

Advance and deduction uploads also provide templates. Use `/salary/advance-template` to download a spreadsheet with columns `employeeid`, `punchingid`, `name`, `amount` and `reason`. For recording salary deductions of an advance, download `/salary/advance-deduction-template` which lists `employeeid`, `punchingid`, `name`, `month` and `amount`.

### Sandwich Dates

Create a table so operators can mark certain dates as "sandwich" days:
```sql
CREATE TABLE sandwich_dates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE NOT NULL,
  UNIQUE KEY uniq_sandwich (date)
);
```
A sandwich day is normally a paid leave. However, if an employee is absent either the day before or the day after, the sandwich day becomes unpaid and is deducted from salary.

Salaries are released 15 days after the end of the month so that any deductions for damage or misconduct can be applied before payout.

### Inventory Webhook Alerts

The `/webhook/inventory` endpoint records incoming webhook data and broadcasts alerts via Server-Sent Events when stock levels fall below their configured threshold.
Requests do not require a session but must include the `Access-Token` header provided by EasyEcom.
Use `/webhook/config` to map each SKU to its own threshold.
Enter one mapping per line in the form `SKU:THRESHOLD`.
Values are stored in `sku_thresholds` so the configuration persists across
server restarts.

To receive browser push notifications you must generate VAPID keys and set
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in your `.env` file. Clients visiting
`/webhook/logs` will register a service worker that subscribes to push updates.
Subscriptions are persisted in the `push_subscriptions` table so notifications
continue working after server restarts.
