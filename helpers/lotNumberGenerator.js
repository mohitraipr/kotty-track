// helpers/lotNumberGenerator.js

const moment = require('moment'); // For date and time formatting

/**
 * Generates a unique lot number in the format: lot-date+currenttime+username
 * Example: LOT-20230101-123045-Johndoe
 * @param {string} username - The username of the current user.
 * @returns {string} - The generated lot number.
 */
function generateLotNumber(username) {
    const date = moment().format('YYYYMMDD'); // Current date
    const time = moment().format('HHmmss');   // Current time
    const sanitizedUsername = username.replace(/\s+/g, '').toLowerCase(); // Remove spaces and lowercase

    return `LOT-${date}-${time}-${sanitizedUsername}`;
}

module.exports = generateLotNumber;
