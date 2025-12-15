# PO Creator Dashboard - Setup and Usage Guide

## Overview
This module provides a comprehensive inward/outward management system for PO creators to track cartons and SKU data.

## Features Implemented

### For PO Creators:
1. **Inward Entry Form**
   - Fill carton details (carton number, date of packing, packed by)
   - Add multiple SKUs per carton
   - SKU composition: Brand Code + Category + SKU Code
   - Size and quantity tracking per SKU
   - Real-time SKU preview

2. **View Inward Data**
   - See all cartons created by the logged-in PO creator
   - Click on cartons to view detailed SKU information
   - Summary statistics (SKU count, total quantity)

3. **Excel Download**
   - Download all inward data in Excel format
   - Includes all carton and SKU details

### For Operators:
1. **View All PO Creators Data**
   - See data from all PO creators in one place
   - Filter by carton number, creator, packed by, or date
   - Download all data to Excel

## Database Setup

### Step 1: Run the SQL Schema
Execute the following SQL file to create all necessary tables:

```bash
mysql -u [username] -p [database_name] < sql/po_creator_tables.sql
```

Or run it directly in your MySQL client:
```sql
source /workspaces/kotty-track/sql/po_creator_tables.sql
```

### Tables Created:
1. **cartons** - Stores carton information
2. **carton_skus** - Stores SKU details for each carton
3. **carton_outward** - Stores outward/dispatch data (for future use)
4. **sku_brand_codes** - Hardcoded brand codes (KTT, KOTTY, KOTY, KOTI, KTY)
5. **sku_categories** - Hardcoded categories (LADIESJEANS, SKIRT, MENSJEANS, WOMENSJEANS, WOMENSPANT)

### Step 2: Create the po_creator Role
You need to add the `po_creator` role to your `roles` table:

```sql
INSERT INTO roles (name, description) VALUES ('po_creator', 'PO Creator - Manages inward/outward data');
```

### Step 3: Create PO Creator Users
Create users with the po_creator role:

```sql
-- First, get the role_id for po_creator
SELECT id FROM roles WHERE name = 'po_creator';

-- Then create a user (replace the password hash with your own)
INSERT INTO users (username, password, role_id, is_active)
VALUES ('pocreator1', '$2a$10$YourHashedPasswordHere', [role_id_from_above], TRUE);
```

To generate a password hash, you can use this Node.js snippet:
```javascript
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('your_password', 10);
console.log(hash);
```

## File Structure

```
/workspaces/kotty-track/
├── sql/
│   └── po_creator_tables.sql          # Database schema
├── routes/
│   └── poCreatorRoutes.js             # All routes for PO creator functionality
├── views/
│   └── po-creator/
│       ├── dashboard.ejs              # PO creator dashboard
│       ├── inward.ejs                 # Inward entry form
│       ├── inward-view.ejs            # View all inward data
│       └── operator-view-all.ejs      # Operator view for all PO creators
├── middlewares/
│   └── auth.js                        # Added isPOCreator middleware
└── app.js                             # Registered routes
```

## Routes

### PO Creator Routes (Protected by isPOCreator middleware):
- `GET /po-creator/dashboard` - Dashboard with navigation cards
- `GET /po-creator/inward` - Inward entry form
- `POST /po-creator/api/inward` - Submit inward data
- `GET /po-creator/inward/view` - View all inward entries
- `GET /po-creator/api/carton/:id` - Get carton details with SKUs
- `GET /po-creator/api/search-cartons` - Search cartons by number or SKU
- `GET /po-creator/download/inward-excel` - Download Excel report

### Operator Routes (Protected by isOperator middleware):
- `GET /po-creator/operator/view-all` - View all PO creators' data
- `GET /po-creator/operator/download-all-excel` - Download all data to Excel

## Usage Instructions

### For PO Creators:

#### 1. Login
- Navigate to the login page
- Enter your credentials
- You'll be redirected to `/po-creator/dashboard`

#### 2. Create Inward Entry
1. Click "Inward Entry" from the dashboard
2. Fill in carton details:
   - Carton Number (must be unique)
   - Date of Packing
   - Packed By
3. Add SKUs:
   - Click "Add SKU" to add rows
   - Select Brand Code from dropdown
   - Select Category from dropdown
   - Enter SKU Code (integer)
   - Enter Size
   - Enter Quantity
   - See live preview of the full SKU
4. Click "Submit Inward Entry"

#### 3. View Your Data
1. Click "View Inward Data" from dashboard
2. See all your cartons as cards
3. Click any carton to see detailed SKU information
4. Download Excel report using the button

### For Operators:

#### 1. Access All Data
- Navigate to `/po-creator/operator/view-all`
- Or add a link in the operator dashboard

#### 2. Filter and Search
- Use the search box to filter by carton number, creator, or packed by
- Use the date picker to filter by packing date
- Clear filters to see all data

#### 3. Download Reports
- Click "Download All Excel" to get a comprehensive report

## SKU Format

SKUs are composed of three parts separated by hyphens:
```
[BRAND_CODE]-[CATEGORY]-[SKU_CODE]
```

Example:
```
KTT-LADIESJEANS-101
KOTTY-MENSJEANS-205
```

### Available Brand Codes:
- KTT
- KOTTY
- KOTY
- KOTI
- KTY

### Available Categories:
- LADIESJEANS
- SKIRT
- MENSJEANS
- WOMENSJEANS
- WOMENSPANT

## Excel Export Format

The Excel export includes the following columns:
- Carton Number
- Date of Packing
- Packed By
- Brand Code
- Category
- SKU Code
- Full SKU
- Size
- Quantity
- Created At

For operator export, an additional "Creator" column is included.

## Future Enhancements (Outward Module)

The outward functionality is prepared but not yet implemented. When ready, it will include:
- Search and select cartons by number or SKU
- Assign PO number
- Set dispatch date
- Add panel name
- Track outward movements

The `carton_outward` table is already created for this purpose.

## Troubleshooting

### Issue: Cannot login as PO Creator
**Solution**: Ensure the `po_creator` role exists in the `roles` table and the user is assigned this role.

### Issue: Database connection errors
**Solution**: Check that all tables are created properly by running the SQL schema file.

### Issue: "Carton number already exists" error
**Solution**: Each carton number must be unique. Use a different carton number.

### Issue: Routes not working
**Solution**: Ensure the server has been restarted after adding the routes.

## Adding to Operator Dashboard

To add a link to the operator dashboard, edit the operator dashboard view file and add:

```html
<div class="col-md-4">
  <a href="/po-creator/operator/view-all" class="action-card">
    <i class="bi bi-people"></i>
    <h3>PO Creators Data</h3>
    <p>View all PO creators' inward data</p>
  </a>
</div>
```

## Security Notes

- All routes are protected by authentication middleware
- PO creators can only see their own data
- Operators can see all PO creators' data
- SQL injection protection via parameterized queries
- Session-based authentication

## Dependencies

All required dependencies are already in package.json:
- express
- mysql2
- exceljs
- bcryptjs
- express-session
- ejs

No additional packages need to be installed.
