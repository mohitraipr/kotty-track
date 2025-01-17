const { pool } = require('../config/db'); // Adjust the path as needed

/**
 * Generates a new lot number in the format:
 * <FirstTwoLettersOfUsername><IncrementingLotNo>
 *
 * @param {string} username - The username of the user.
 * @param {number|string} userId - The unique identifier for the user.
 * @param {object} conn - The MySQL connection object.
 * @returns {Promise<string>} The generated lot number.
 * @throws {Error} If username or userId is invalid or if database query fails.
 */
async function generateLotNumber(username, userId, conn) {
  // Validate inputs
  if (typeof username !== 'string' || username.trim() === '') {
    throw new Error('Invalid username provided.');
  }

  if (typeof userId !== 'number' && typeof userId !== 'string') {
    throw new Error('Invalid user ID provided.');
  }

  // Sanitize username: remove spaces, convert to lowercase, and extract first two characters
  const sanitizedUsername = username.replace(/\s+/g, '').toLowerCase().substring(0, 2);

  try {
    // Fetch the last lot number for this user from the database with row lock
    const [rows] = await conn.query(
      `
      SELECT lot_no 
      FROM cutting_lots 
      WHERE user_id = ?
      ORDER BY id DESC 
      LIMIT 1
      FOR UPDATE
    `,
      [userId]
    );

    let lastNumber = 0; // Default if no previous lot exists

    if (rows.length > 0) {
      const lastLotNumber = rows[0].lot_no;

      // Extract the numeric part of the lot number
      const numericPart = lastLotNumber.substring(2); // Skip the first two characters
      const parsedNumber = parseInt(numericPart, 10);

      if (!isNaN(parsedNumber)) {
        lastNumber = parsedNumber;
      }
    }

    const newNumber = lastNumber + 1;

    // Generate the new lot number
    const newLotNumber = `${sanitizedUsername}${newNumber}`;

    return newLotNumber;
  } catch (err) {
    console.error('Error generating lot number:', err);
    throw new Error('Failed to generate lot number.');
  }
}

module.exports = generateLotNumber;
