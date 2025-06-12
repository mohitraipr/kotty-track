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
  UNIQUE KEY uniq_emp_day (employee_id, work_date)
);
```

`employee_daily_hours` records how many hours an employee worked on a given day. Later you can calculate under time or overtime by comparing `hours_worked` with the employee's `working_hours`.
