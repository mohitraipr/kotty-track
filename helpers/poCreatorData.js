const { pool } = require('../config/db');

let poCreatorLotEntriesSchemaReady = false;

async function ensurePoCreatorLotEntriesSchema() {
  if (poCreatorLotEntriesSchemaReady) {
    return;
  }

  const [[row]] = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'po_creator_lot_entries'
      AND COLUMN_NAME = 'entry_date'
    `
  );

  if (row.count === 0) {
    await pool.query(
      'ALTER TABLE po_creator_lot_entries ADD COLUMN entry_date DATE DEFAULT NULL'
    );
  }

  poCreatorLotEntriesSchemaReady = true;
}

module.exports = {
  ensurePoCreatorLotEntriesSchema
};
