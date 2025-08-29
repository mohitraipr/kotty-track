# Kotty Track

Kotty Track is a Node.js and Express application used to manage the production workflow and employee operations of a garment unit.  It features role based dashboards for administrators, operators, supervisors and store staff.  Data is stored in MySQL and views are rendered using EJS templates.

## Features

- **Authentication** â Users log in and are redirected to dashboards based on their role.
- **Admin tools** â Manage roles, users and dynamically create dashboard tables.
- **Production workflow** â Routes exist for fabric, cutting, stitching, finishing, washing and jeans assembly managers.
- **Employee management** â Supervisors register employees, record attendance, handle salary calculations and upload night shift data.
- **Store inventory** â Store admins maintain the list of goods while store employees add incoming stock and record dispatches.
- **Bulk upload & search** â Operators can upload attendance files and perform bulk updates; Excel exports are available throughout the system.
- **Supervisor cleanup** â Operators can remove a supervisor's employees and all related records in one action.
- **Audit logging** â Important actions are written to log files for later review.
- **Washer monthly summary** – Export monthly washer statistics including assigned, completed, pending pieces and completion percentage.
- **Salary breakdown** – Monthly salary exports now show daily hours with corresponding earnings and the total count of miss punches.

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
   DB_PASSWORD=
   DB_NAME=
   SESSION_SECRET=your-session-secret
   PORT=3000
   NODE_ENV=development
   # Token used to validate EasyEcom webhooks
   EASYEECOM_ACCESS_TOKEN=
  ```
   Encrypt the file:
   ```bash
   npx secure-env .env -s {yourPassword}
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
CREATE TABLE table_name (

);

INSERT INTO goods_inventory () VALUES


CREATE TABLE incoming_data (

);

CREATE TABLE dispatched_data (
 
);
```
`incoming_data` stores every addition with timestamp and user while `dispatched_data` tracks quantity sent out along with remarks.

Create a table to persist inventory alerts triggered by the webhook:
```sql
CREATE TABLE inventory_alerts (

);

CREATE TABLE push_subscriptions (
 
);

CREATE TABLE sku_thresholds (
 
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

);

CREATE TABLE department_supervisors (
 
);
```
Operators can create departments and assign `supervisor` users to them from the Department Management screen.

### Supervisor Employees

To let supervisors manage their own employees, create the following table:
```sql
CREATE TABLE employees (
 
);
```
The employees table now includes an optional `aadhar_card_number VARCHAR(20)` column for storing Aadhar information.

Each supervisor must assign unique punching IDs to their employees. This ensures no duplicate entries. Employees earn leave and salary details stored in `employee_salaries`. These actions are available from the operator dashboard, which also lists each supervisor with their active employee count and total monthly salary.

### Employee Leaves

Supervisors can track leaves for their employees using this table:
```sql
CREATE TABLE employee_leaves (
 
);
```
Employees normally earn 1.5 days of leave starting in their third month of service.
Supervisors may set the `leave_start_months` value per employee to change when this accrual begins.
Each subsequent month after the start month grants another 1.5 days.
Daily wage (`dihadi`) workers are paid only for hours worked and do not accumulate leaves.

### Employee Debits & Advances

Supervisors may record financial debits or advances for their employees. Use separate tables linked to the employee:
```sql
CREATE TABLE employee_debits (

);

CREATE TABLE employee_advances (

);

CREATE TABLE advance_deductions (
 
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

);

CREATE TABLE employee_salaries (
 
);
```
Update the `employees` table to store each worker's allotted hours per day:
```sql
ALTER TABLE employees ADD COLUMN column DECIMAL(4,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN column BOOLEAN NOT NULL DEFAULT TRUE;
```

Lunch breaks are deducted from recorded hours only for workers paid on a `dihadi` (daily wage) basis. Monthly salary employees keep their full punch duration.

`dihadi` workers do not receive any special treatment for Sundays. Their pay is purely based on hours worked.

Punching in after **09:15** normally deducts **one hour** from the day's counted hours for **dihadi** (daily wage) workers. When the arrival is later than 40% of the allotted shift hours no late deduction is applied.

Monthly employees paid hourly receive their full allotted hours when both punches are present and the punch in time is before **09:15**.

### Sunday Attendance Rules

- Sundays are paid at the normal day rate even when the employee is absent, unless the sandwich rule applies.
- Worked Sundays always earn double pay.
- **Mandatory Sundays** â if `paid_sunday_allowance` is greater than zero the employee must work that many Sundays in the month. Missing one counts as an absence and these required days never earn extra pay.

For most teams, a Sunday becomes unpaid whenever the employee is absent on the adjacent Saturday or Monday. If both days are missed, all three (SaturdayâSundayâMonday) are deducted from salary. Teams supervised by **Rohit Shukla** follow the old rule where Sunday counts only when Saturday *and* Monday are absent. When the employee works on that Sunday, any adjacent absence is paid as usual.

### Attendance Edit Logs

Operators can adjust an employee's punch in/out times. A log table tracks these updates and limits each employee to thirty-five edits total:
```sql
CREATE TABLE attendance_edit_logs (
  
);
```
Operators can modify punch times from the dashboard, but once thirty-five rows exist in `attendance_edit_logs` for an employee no further edits are allowed. Every update recalculates the employee's salary for that month.

### Attendance Edit Routes

Several endpoints update attendance records and then recalculate salary using
`helpers/salaryCalculator.js`:

- `POST /operator/employees/:id/edit` â update a single day of attendance
  for one employee.
- `POST /operator/supervisors/:id/bulk-attendance` â bulk edit a specific date
  for all employees under a supervisor.
- `POST /operator/employees/:id/bulk-attendance` â edit an entire month of
  attendance for one employee.
- `POST /departments/fix-miss-punch` â automatically correct "one punch only"
  entries for a single employee.
- `POST /departments/bulk-fix-miss-punch` â upload an Excel file to fix many
  employees at once.

Each of these routes calls `calculateSalaryForMonth` after saving attendance so
that both monthly and dihadi salaries are updated with any advance deductions.

### Night Shift Uploads

Operators can upload a monthly Excel sheet listing the night shifts worked by employees. Create a table to store these uploads:
```sql
CREATE TABLE employee_nights (
 
);
```
Uploading a sheet increases the employee's salary by `nights * (salary / days_in_month)` for the specified month. Duplicate uploads for the same employee and month are ignored. Operators can download an Excel template via the `/salary/night-template` route. The file includes the columns `supervisorname`, `supervisordepartment`, `punchingid`, `name`, `nights`, `month`.

Advance and deduction uploads also provide templates. Use `/salary/advance-template` to download a spreadsheet with columns `employeeid`, `punchingid`, `name`, `amount` and `reason`. For recording salary deductions of an advance, download `/salary/advance-deduction-template` which lists `employeeid`, `punchingid`, `name`, `month` and `amount`.

### Sandwich Dates

Create a table so operators can mark certain dates as "sandwich" days:
```sql
CREATE TABLE sandwich_dates (
 
);
```
A sandwich day is normally a paid leave. However, if an employee is absent either the day before or the day after, the sandwich day becomes unpaid and is deducted from salary.

Salaries are released 15 days after the end of the month so that any deductions for damage or misconduct can be applied before payout.

### Attendance and Payroll Rules

The application enforces a number of salary calculation rules. These come
primarily from `helpers/salaryCalculator.js` and related routes.

#### Daily Hours and Lunch Breaks

- A lunch break is automatically deducted for **dihadi** (daily wage) workers
  based on their punch‑out time:
  - 0 minutes if the employee leaves before **13:10**.
  - 30 minutes if the employee leaves between **13:10** and **18:10**.
- 60 minutes for any punch‑out after **18:10** when the shift begins before the
  40% mark; otherwise only **30 minutes** is deducted.
Dihadi workers arriving after **09:15** lose **one hour** from their total
working hours, unless their punch in time is later than **40%** of the allotted
shift. Their day is still capped at **11 working hours**.

#### Monthly Worker Attendance

- Monthly employees have an `allotted_hours` value. When the hours worked for a
  day are below certain thresholds the day is deducted:
  - Less than **40%** of the allotted hours -> marked **Absent**.
  - Between **40%** and **85%** -> counts as a **Half Day**.

#### Sunday Rules

- Employees are only paid for a Sunday when valid punch in/out times result in
  positive working hours.
- If an employee is absent on the Saturday or Monday adjacent to a Sunday, that
  Sunday normally becomes unpaid. When both days are missed the entire
  Saturday–Sunday–Monday period is deducted.
- `paid_sunday_allowance` specifies how many Sundays per month are mandatory.
  Missing one counts as an absence. After the allowance is met, Sundays worked
  are paid double when neither Saturday nor Monday is absent.
- Supervisors listed in `utils/supervisors.js` follow an older rule where Sunday
  counts as an absence only when **both** Saturday *and* Monday are missed. A
  worked Sunday under these supervisors is always paid.

#### Sandwich Days

- Dates stored in the `sandwich_dates` table are normally treated as paid leave.
  However, if the employee is absent on the day before **or** the day after, the
  sandwich day becomes unpaid and is deducted from salary.

### Inventory Webhook Alerts

The `/webhook/inventory` endpoint records incoming webhook data and broadcasts alerts via Server-Sent Events when stock levels fall below their configured threshold.
Requests do not require a session but must include the `Access-Token` header provided by EasyEcom.
Use `/webhook/config` to map each SKU to its own threshold.
Enter one mapping per line in the form `SKU:THRESHOLD`.
Values are stored in `sku_thresholds` so the configuration persists across
server restarts.
The configuration page also provides a **Remove All** button to clear all saved thresholds in one step.

To receive browser push notifications you must generate VAPID keys and set
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in your `.env` file. Clients visiting
`/webhook/logs` will register a service worker that subscribes to push updates.
Subscriptions are persisted in the `push_subscriptions` table so notifications
continue working after server restarts.
Inventory alerts are aggregated and a single push notification is sent every
three hours. Clicking the notification opens `/inventory/alerts` where the
latest low stock events are listed.

### Stitching Payments

Two new tables support recording payments to stitching masters.

Create a table to store a per-SKU contract rate:
```sql
CREATE TABLE stitching_rates (
  sku VARCHAR(50) PRIMARY KEY,
  rate DECIMAL(10,2) NOT NULL
);
```

Operation rates are kept in a separate table:
```sql
CREATE TABLE stitching_operation_rates (
  operation VARCHAR(50) PRIMARY KEY,
  rate DECIMAL(10,2) NOT NULL
);
```

Contract payments are captured in `stitching_payments_contract`:
```sql
CREATE TABLE stitching_payments_contract (
  id INT AUTO_INCREMENT PRIMARY KEY,
  master_id INT NOT NULL,
  lot_no VARCHAR(50) NOT NULL,
  sku VARCHAR(50) NOT NULL,
  qty INT NOT NULL,
  rate DECIMAL(10,2) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  paid_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Operation based payments use a separate table:
```sql
CREATE TABLE stitching_operation_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  master_id INT NOT NULL,
  lot_no VARCHAR(50) NOT NULL,
  operation VARCHAR(50) NOT NULL,
  worker_name VARCHAR(100) NOT NULL,
  qty INT NOT NULL,
  rate DECIMAL(10,2) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  paid_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The operator dashboard exposes a page to maintain `stitching_rates` so contract
amounts can be calculated automatically.

### Washing Payments

Store per-item washing rates in the `washing_item_rates` table:

```sql
CREATE TABLE washing_item_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  description VARCHAR(100) NOT NULL UNIQUE,
  rate DECIMAL(10,2) NOT NULL DEFAULT 0
);
```

Operators can add items such as "ice wash" or "acid wash" and set the amount to be paid for each from the washing payment dashboard.

### Purchase Dashboard

The Purchase dashboard stores party and factory details along with simple
payment terms.

```sql
CREATE TABLE parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gst_number VARCHAR(50),
  state VARCHAR(100),
  pincode VARCHAR(20),
  due_payment_days INT DEFAULT 0
);

CREATE TABLE factories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gst_number VARCHAR(50),
  state VARCHAR(100)
);

-- allow purchaseGRN users to sign in
INSERT INTO roles (name) VALUES ('purchaseGRN');
```

`due_payment_days` records how many days after billing a payment becomes due.
Accounts users can edit this number but only the day count is stored.
