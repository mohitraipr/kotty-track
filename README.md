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
