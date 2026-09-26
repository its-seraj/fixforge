'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.fixforge', 'logs');

const logger = winston.createLogger({
  level: process.env.FIXFORGE_LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'fixforge-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      maxSize: '20m',
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'fixforge-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
    }),
  ],
});

// Also log to console unless in dashboard mode
if (process.env.FIXFORGE_QUIET !== '1') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${extras}`;
        })
      ),
    })
  );
}

// Silence console transport in TUI/dashboard mode
logger.silenceConsole = function () {
  logger.transports.forEach((t) => {
    if (t instanceof winston.transports.Console) {
      logger.remove(t);
    }
  });
};

module.exports = logger;
