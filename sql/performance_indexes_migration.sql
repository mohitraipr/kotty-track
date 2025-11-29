-- ====================================================================
-- PERFORMANCE INDEXES MIGRATION
-- ====================================================================
-- This migration adds critical indexes to improve database query performance
-- Run this script to reduce server load and improve response times
--
-- IMPORTANT: Run during low-traffic hours as index creation can lock tables
-- ====================================================================

-- Check current indexes before running (optional - for verification)
-- SHOW INDEX FROM cutting_lots;
-- SHOW INDEX FROM stitching_data;
-- etc...

-- ====================================================================
-- CUTTING_LOTS TABLE INDEXES
-- ====================================================================

-- Index for lot number lookups and joins (most frequently used)
CREATE INDEX idx_cutting_lots_lot_no
  ON cutting_lots(lot_no);

-- Index for SKU searches
CREATE INDEX idx_cutting_lots_sku
  ON cutting_lots(sku);

-- Index for date range filtering in analytics
CREATE INDEX idx_cutting_lots_created_at
  ON cutting_lots(created_at);

-- Composite index for common filtering patterns
CREATE INDEX idx_cutting_lots_sku_created
  ON cutting_lots(sku, created_at);

-- ====================================================================
-- STITCHING_DATA TABLE INDEXES
-- ====================================================================

-- Index for lot number joins
CREATE INDEX idx_stitching_data_lot_no
  ON stitching_data(lot_no);

-- Index for user-specific queries
CREATE INDEX idx_stitching_data_user_id
  ON stitching_data(user_id);

-- Composite index for user + lot queries
CREATE INDEX idx_stitching_data_user_lot
  ON stitching_data(user_id, lot_no);

-- Index for date filtering
CREATE INDEX idx_stitching_data_created_at
  ON stitching_data(created_at);

-- Index for SKU searches
CREATE INDEX idx_stitching_data_sku
  ON stitching_data(sku);

-- ====================================================================
-- STITCHING_ASSIGNMENTS TABLE INDEXES
-- ====================================================================

-- Index for user assignment queries
CREATE INDEX idx_stitching_assignments_user_id
  ON stitching_assignments(user_id);

-- Index for approval status filtering
CREATE INDEX idx_stitching_assignments_isApproved
  ON stitching_assignments(isApproved);

-- Composite index for user + approval status (very common pattern)
CREATE INDEX idx_stitching_assignments_user_approved
  ON stitching_assignments(user_id, isApproved);

-- Index for cutting lot lookups
CREATE INDEX idx_stitching_assignments_cutting_lot_id
  ON stitching_assignments(cutting_lot_id);

-- Index for assigned date sorting
CREATE INDEX idx_stitching_assignments_assigned_on
  ON stitching_assignments(assigned_on);

-- Index for approved date filtering
CREATE INDEX idx_stitching_assignments_approved_on
  ON stitching_assignments(approved_on);

-- ====================================================================
-- WASHING_DATA TABLE INDEXES
-- ====================================================================

-- Index for lot number joins
CREATE INDEX idx_washing_data_lot_no
  ON washing_data(lot_no);

-- Index for user-specific queries
CREATE INDEX idx_washing_data_user_id
  ON washing_data(user_id);

-- Composite index for user + lot queries
CREATE INDEX idx_washing_data_user_lot
  ON washing_data(user_id, lot_no);

-- Index for date filtering
CREATE INDEX idx_washing_data_created_at
  ON washing_data(created_at);

-- Index for SKU searches
CREATE INDEX idx_washing_data_sku
  ON washing_data(sku);

-- ====================================================================
-- WASHING_ASSIGNMENTS TABLE INDEXES
-- ====================================================================

-- Index for user assignment queries
CREATE INDEX idx_washing_assignments_user_id
  ON washing_assignments(user_id);

-- Index for approval status filtering
CREATE INDEX idx_washing_assignments_is_approved
  ON washing_assignments(is_approved);

-- Composite index for user + approval status
CREATE INDEX idx_washing_assignments_user_approved
  ON washing_assignments(user_id, is_approved);

-- Index for jeans assembly assignment lookups
CREATE INDEX idx_washing_assignments_jeans_assembly_id
  ON washing_assignments(jeans_assembly_assignment_id);

-- Index for assigned date sorting
CREATE INDEX idx_washing_assignments_assigned_on
  ON washing_assignments(assigned_on);

-- Index for approved date filtering (used in washer activity queries)
CREATE INDEX idx_washing_assignments_approved_on
  ON washing_assignments(approved_on);

-- ====================================================================
-- WASHING_IN_DATA TABLE INDEXES
-- ====================================================================

-- Index for lot number joins
CREATE INDEX idx_washing_in_data_lot_no
  ON washing_in_data(lot_no);

-- Index for user-specific queries
CREATE INDEX idx_washing_in_data_user_id
  ON washing_in_data(user_id);

-- Index for date filtering
CREATE INDEX idx_washing_in_data_created_at
  ON washing_in_data(created_at);

-- Index for SKU searches
CREATE INDEX idx_washing_in_data_sku
  ON washing_in_data(sku);

-- ====================================================================
-- WASHING_IN_ASSIGNMENTS TABLE INDEXES
-- ====================================================================

-- Index for user assignment queries
CREATE INDEX idx_washing_in_assignments_user_id
  ON washing_in_assignments(user_id);

-- Index for approval status filtering
CREATE INDEX idx_washing_in_assignments_is_approved
  ON washing_in_assignments(is_approved);

-- Composite index for user + approval status
CREATE INDEX idx_washing_in_assignments_user_approved
  ON washing_in_assignments(user_id, is_approved);

-- Index for washing data lookups
CREATE INDEX idx_washing_in_assignments_washing_data_id
  ON washing_in_assignments(washing_data_id);

-- Index for assigned date sorting
CREATE INDEX idx_washing_in_assignments_assigned_on
  ON washing_in_assignments(assigned_on);

-- ====================================================================
-- FINISHING_DATA TABLE INDEXES
-- ====================================================================

-- Index for lot number joins
CREATE INDEX idx_finishing_data_lot_no
  ON finishing_data(lot_no);

-- Index for user-specific queries
CREATE INDEX idx_finishing_data_user_id
  ON finishing_data(user_id);

-- Composite index for user + lot queries
CREATE INDEX idx_finishing_data_user_lot
  ON finishing_data(user_id, lot_no);

-- Index for date filtering
CREATE INDEX idx_finishing_data_created_at
  ON finishing_data(created_at);

-- Index for SKU searches
CREATE INDEX idx_finishing_data_sku
  ON finishing_data(sku);

-- ====================================================================
-- FINISHING_ASSIGNMENTS TABLE INDEXES
-- ====================================================================

-- Index for user assignment queries
CREATE INDEX idx_finishing_assignments_user_id
  ON finishing_assignments(user_id);

-- Index for approval status filtering
CREATE INDEX idx_finishing_assignments_is_approved
  ON finishing_assignments(is_approved);

-- Composite index for user + approval status
CREATE INDEX idx_finishing_assignments_user_approved
  ON finishing_assignments(user_id, is_approved);

-- Index for stitching assignment lookups
CREATE INDEX idx_finishing_assignments_stitching_id
  ON finishing_assignments(stitching_assignment_id);

-- Index for washing in data lookups
CREATE INDEX idx_finishing_assignments_washing_in_id
  ON finishing_assignments(washing_in_data_id);

-- Index for assigned date sorting
CREATE INDEX idx_finishing_assignments_assigned_on
  ON finishing_assignments(assigned_on);

-- ====================================================================
-- JEANS_ASSEMBLY_DATA TABLE INDEXES
-- ====================================================================

-- Index for lot number joins
CREATE INDEX idx_jeans_assembly_data_lot_no
  ON jeans_assembly_data(lot_no);

-- Index for user-specific queries
CREATE INDEX idx_jeans_assembly_data_user_id
  ON jeans_assembly_data(user_id);

-- Index for date filtering
CREATE INDEX idx_jeans_assembly_data_created_at
  ON jeans_assembly_data(created_at);

-- ====================================================================
-- EMPLOYEES TABLE INDEXES
-- ====================================================================

-- Index for supervisor queries
CREATE INDEX idx_employees_supervisor_id
  ON employees(supervisor_id);

-- Index for punching ID lookups
CREATE INDEX idx_employees_punching_id
  ON employees(punching_id);

-- Index for active employee filtering
CREATE INDEX idx_employees_is_active
  ON employees(is_active);

-- Composite index for supervisor + active employees
CREATE INDEX idx_employees_supervisor_active
  ON employees(supervisor_id, is_active);

-- ====================================================================
-- EMPLOYEE_ATTENDANCE TABLE INDEXES
-- ====================================================================

-- Composite index for employee + date (most common query pattern)
CREATE INDEX idx_employee_attendance_emp_date
  ON employee_attendance(employee_id, date);

-- Index for date range queries
CREATE INDEX idx_employee_attendance_date
  ON employee_attendance(date);

-- Index for employee lookups
CREATE INDEX idx_employee_attendance_employee_id
  ON employee_attendance(employee_id);

-- Index for status filtering
CREATE INDEX idx_employee_attendance_status
  ON employee_attendance(status);

-- ====================================================================
-- ATTENDANCE_EDIT_LOGS TABLE INDEXES
-- ====================================================================

-- Index for employee edit history
CREATE INDEX idx_attendance_edit_logs_employee_id
  ON attendance_edit_logs(employee_id);

-- Index for operator tracking
CREATE INDEX idx_attendance_edit_logs_operator_id
  ON attendance_edit_logs(operator_id);

-- Index for date filtering
CREATE INDEX idx_attendance_edit_logs_attendance_date
  ON attendance_edit_logs(attendance_date);

-- ====================================================================
-- USERS TABLE INDEXES
-- ====================================================================

-- Index for role-based queries
CREATE INDEX idx_users_role_id
  ON users(role_id);

-- Index for username lookups (if not already unique)
CREATE INDEX idx_users_username
  ON users(username);

-- ====================================================================
-- ROLES TABLE INDEXES
-- ====================================================================

-- Index for role name lookups (used in subqueries)
CREATE INDEX idx_roles_name
  ON roles(name);

-- ====================================================================
-- FINISHING_DATA_SIZES TABLE INDEXES
-- ====================================================================

-- Composite index for finishing data + size lookups
CREATE INDEX idx_finishing_data_sizes_fd_size
  ON finishing_data_sizes(finishing_data_id, size_label);

-- Index for finishing data lookups
CREATE INDEX idx_finishing_data_sizes_fd_id
  ON finishing_data_sizes(finishing_data_id);

-- ====================================================================
-- FINISHING_DISPATCHES TABLE INDEXES
-- ====================================================================

-- Composite index for dispatch queries
CREATE INDEX idx_finishing_dispatches_fd_size
  ON finishing_dispatches(finishing_data_id, size_label);

-- Index for finishing data lookups
CREATE INDEX idx_finishing_dispatches_fd_id
  ON finishing_dispatches(finishing_data_id);

-- ====================================================================
-- STITCHING_DATA_SIZES TABLE INDEXES
-- ====================================================================

-- Index for stitching data lookups
CREATE INDEX idx_stitching_data_sizes_sd_id
  ON stitching_data_sizes(stitching_data_id);

-- ====================================================================
-- WASHING_IN_DATA_SIZES TABLE INDEXES
-- ====================================================================

-- Index for washing in data lookups
CREATE INDEX idx_washing_in_data_sizes_wd_id
  ON washing_in_data_sizes(washing_in_data_id);

-- ====================================================================
-- CUTTING_LOT_SIZES TABLE INDEXES
-- ====================================================================

-- Index for cutting lot lookups (used to avoid N+1)
CREATE INDEX idx_cutting_lot_sizes_lot_id
  ON cutting_lot_sizes(cutting_lot_id);

-- ====================================================================
-- VERIFICATION QUERIES
-- ====================================================================
-- Run these to verify indexes were created successfully:
--
-- SHOW INDEX FROM cutting_lots WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM stitching_data WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM washing_data WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM finishing_data WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM employee_attendance WHERE Key_name LIKE 'idx_%';
--
-- To check index usage:
-- EXPLAIN SELECT ... (your query here)
-- ====================================================================

-- ====================================================================
-- ANALYZE TABLES AFTER INDEX CREATION
-- ====================================================================
-- This helps MySQL optimize query plans with new indexes

ANALYZE TABLE cutting_lots;
ANALYZE TABLE stitching_data;
ANALYZE TABLE stitching_assignments;
ANALYZE TABLE washing_data;
ANALYZE TABLE washing_assignments;
ANALYZE TABLE washing_in_data;
ANALYZE TABLE washing_in_assignments;
ANALYZE TABLE finishing_data;
ANALYZE TABLE finishing_assignments;
ANALYZE TABLE jeans_assembly_data;
ANALYZE TABLE employees;
ANALYZE TABLE employee_attendance;
ANALYZE TABLE attendance_edit_logs;
ANALYZE TABLE users;
ANALYZE TABLE roles;
ANALYZE TABLE finishing_data_sizes;
ANALYZE TABLE finishing_dispatches;
ANALYZE TABLE stitching_data_sizes;
ANALYZE TABLE washing_in_data_sizes;
ANALYZE TABLE cutting_lot_sizes;

-- ====================================================================
-- NOTES:
-- ====================================================================
-- 1. These indexes significantly improve query performance
-- 2. Indexes use additional disk space (estimated 10-20% of table size)
-- 3. Indexes slightly slow down INSERT/UPDATE operations (negligible)
-- 4. Monitor index usage with:
--    SELECT * FROM sys.schema_unused_indexes;
-- 5. For very large tables, consider using ALGORITHM=INPLACE:
--    CREATE INDEX ... USING BTREE ALGORITHM=INPLACE;
-- ====================================================================
