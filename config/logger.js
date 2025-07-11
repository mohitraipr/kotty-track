// config/logger.js

const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: 'info',
  format: format.combine(
      // Use IST for all timestamps
      format.timestamp({ format: () => new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) }),
      format.json()
  ),
  transports: [
      new transports.File({ filename: 'logs/error.log', level: 'error' }),
      new transports.File({ filename: 'logs/combined.log' }),
  ],
});

// If not in production, log to console as well
if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
      format: format.simple(),
  }));
}

module.exports = logger;
