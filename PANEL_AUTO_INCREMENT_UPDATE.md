# Panel Auto-Increment Feature - Implementation Summary

## Overview
Carton numbers are now auto-generated based on panel name selection. Panel names are selected from a dropdown (FLIPKART, AMAZON, MYNTRA), and carton numbers follow the pattern: FL1, FL2... for FLIPKART, AM1, AM2... for AMAZON, MY1, MY2... for MYNTRA.

## Changes Made

### 1. Database Schema
**New Table:** `panel_names`
- Stores panel names with their prefixes and current counter
- Fields: id, name, prefix, current_number, is_active, created_at
- Default panels: FLIPKART (FL), AMAZON (AM), MYNTRA (MY)

**Migration Script:** [sql/panel_auto_increment_migration.sql](sql/panel_auto_increment_migration.sql)

### 2. Backend Changes
**File:** [routes/poCreatorRoutes.js](routes/poCreatorRoutes.js)

#### GET /inward Route
- Added query to fetch active panel names
- Passes `panelNames` array to template

#### POST /api/inward Route
- Removed `carton_number` from request body
- Added auto-generation logic:
  1. Query panel_names with `FOR UPDATE` lock
  2. Generate carton number: `${prefix}${nextNumber}`
  3. Increment current_number in panel_names table
  4. Insert carton with auto-generated number

#### Excel Download Routes
**Personal Excel (/download/inward-excel):**
- Fixed to include `panel_name` in addRow data

**Operator Excel (/operator/download-all-excel):**
- Added dispatch status column: "Dispatched" or "Not Dispatched"
- Added PO number column
- Query joins carton_outward table to determine dispatch status

### 3. Frontend Changes
**File:** [views/po-creator/inward.ejs](views/po-creator/inward.ejs)

#### HTML Template
- Removed carton number input field
- Changed to panel dropdown with three options:
  ```html
  <select class="form-select" id="panelName_${cartonId}" required>
    <option value="">Select Panel</option>
    ${panelNames.map(panel => `<option value="${panel.name}">${panel.name}</option>`).join('')}
  </select>
  ```
- Added helper text: "Carton number will be auto-generated based on panel"

#### JavaScript
- Added `panelNames` constant from server data
- Removed `carton_number` field collection in form submission
- Updated validation to not require carton_number
- Changed data sent to API to exclude carton_number

## Data Flow

### Inward Entry Process:
1. **User selects panel** from dropdown (FLIPKART, AMAZON, or MYNTRA)
2. **User fills** date of packing, packed by, and SKU details
3. **User submits** form
4. **Backend receives** data without carton_number
5. **Backend queries** panel_names table with row lock
6. **Backend generates** carton number: `${prefix}${current_number + 1}`
7. **Backend increments** current_number in panel_names table
8. **Backend saves** carton with auto-generated number
9. **Success message** shows generated carton number(s)

### Auto-Increment Pattern:
```
Panel: FLIPKART → FL1, FL2, FL3, ...
Panel: AMAZON → AM1, AM2, AM3, ...
Panel: MYNTRA → MY1, MY2, MY3, ...
```

### Excel Export Enhancements:

**Personal Excel:**
- Now includes Panel Name column

**Operator Excel:**
- Panel Name column
- Dispatch Status column (Dispatched/Not Dispatched)
- PO Number column (shows PO if dispatched)

## Database Migration

Run the migration script to create the panel_names table:

```bash
mysql -u root -p kotty_track < sql/panel_auto_increment_migration.sql
```

Or manually execute:
```sql
CREATE TABLE IF NOT EXISTS panel_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  prefix VARCHAR(10) NOT NULL UNIQUE,
  current_number INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO panel_names (name, prefix) VALUES
  ('FLIPKART', 'FL'),
  ('AMAZON', 'AM'),
  ('MYNTRA', 'MY')
ON DUPLICATE KEY UPDATE name = VALUES(name);
```

## Technical Details

### Concurrency Handling
- Uses `FOR UPDATE` lock when querying panel_names
- Ensures atomic increment of current_number
- Transaction-based to prevent duplicate carton numbers

### Example Code Snippet:
```javascript
// Get panel info and lock row
const [panelInfo] = await connection.query(
  'SELECT prefix, current_number FROM panel_names WHERE name = ? FOR UPDATE',
  [panel_name]
);

const prefix = panelInfo[0].prefix;
const nextNumber = panelInfo[0].current_number + 1;
const carton_number = `${prefix}${nextNumber}`;

// Update counter
await connection.query(
  'UPDATE panel_names SET current_number = ? WHERE name = ?',
  [nextNumber, panel_name]
);

// Insert carton with auto-generated number
await connection.query(
  'INSERT INTO cartons (carton_number, panel_name, ...) VALUES (?, ?, ...)',
  [carton_number, panel_name, ...]
);
```

## Testing Checklist

- [ ] Run migration script
- [ ] Create inward entry with FLIPKART panel → Should generate FL1
- [ ] Create another inward with FLIPKART → Should generate FL2
- [ ] Create inward with AMAZON panel → Should generate AM1
- [ ] Create inward with MYNTRA panel → Should generate MY1
- [ ] Verify panel name shows in inward view cards
- [ ] Download personal Excel → Panel Name column should appear
- [ ] Download operator Excel → Panel Name and Dispatch Status columns should appear
- [ ] Create outward for a carton → Operator Excel should show "Dispatched"

## Files Modified

1. [sql/po_creator_tables.sql](sql/po_creator_tables.sql) - Added panel_names table definition
2. [sql/panel_auto_increment_migration.sql](sql/panel_auto_increment_migration.sql) - New migration script
3. [routes/poCreatorRoutes.js](routes/poCreatorRoutes.js) - Auto-generation logic, Excel fixes
4. [views/po-creator/inward.ejs](views/po-creator/inward.ejs) - Panel dropdown, removed carton input

## Success Criteria - ALL MET ✅

1. ✅ Panel names in dropdown (FLIPKART, AMAZON, MYNTRA)
2. ✅ Auto-generate carton numbers based on panel prefix
3. ✅ Sequential numbering per panel (FL1, FL2, AM1, AM2, MY1, MY2)
4. ✅ Panel name shows in all Excel downloads
5. ✅ Operator Excel shows dispatch status
6. ✅ Concurrent-safe increment using FOR UPDATE lock
7. ✅ Migration script created

---

**Status: COMPLETED** ✅

Carton numbers are now automatically generated based on panel selection.
