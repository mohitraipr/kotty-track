const DEFAULT_PREFIX = 'ap';

function extractPrefix(username) {
  if (!username || typeof username !== 'string') {
    return DEFAULT_PREFIX;
  }
  const cleaned = username.replace(/\s+/g, '').toLowerCase();
  if (!cleaned) {
    return DEFAULT_PREFIX;
  }
  return cleaned.substring(0, 2).padEnd(2, 'x');
}

async function generateApiLotNumber(username, userId, conn) {
  if (!conn || typeof conn.query !== 'function') {
    throw new Error('A valid database connection is required to generate the lot number.');
  }

  const prefix = extractPrefix(username);

  const [rows] = await conn.query(
    `
      SELECT lot_number
      FROM api_lots
      WHERE cutting_master_id = ?
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [userId]
  );

  let counter = 0;
  if (rows.length > 0 && rows[0].lot_number) {
    const match = rows[0].lot_number.match(/(\d+)$/);
    if (match) {
      counter = parseInt(match[1], 10) || 0;
    }
  }

  const nextCounter = counter + 1;
  const numeric = String(nextCounter);

  return `${prefix}${numeric}`;
}

module.exports = generateApiLotNumber;
