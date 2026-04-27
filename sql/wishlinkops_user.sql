-- Step 1: Create wishlinkops role
INSERT IGNORE INTO roles (name, description) VALUES ('wishlinkops', 'WishLink Operations - Inventory logs access only');

-- Step 2: Verify role was created
SELECT id, name FROM roles WHERE name = 'wishlinkops';

-- Step 3: Create user via Admin Panel at /admin
-- Username: vinaykumar
-- Password: vinaykumar@v123
-- Role: wishlinkops (select from dropdown)

-- OR run this after generating hash:
-- SET @role_id = (SELECT id FROM roles WHERE name = 'wishlinkops');
-- INSERT INTO users (username, password, role_id) VALUES ('vinaykumar', '<BCRYPT_HASH>', @role_id);
