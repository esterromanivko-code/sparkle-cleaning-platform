'use strict';
// lib/logger.js — Structured logging with Winston + Morgan HTTP logging
// In production: logs go to files + console in JSON format
// In development: pretty colored console output

const winston = require('winston');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isProd = process.env.NODE_ENV === 'production';

// ── Winston logger ────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: isProd
    ? winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      )
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
  transports: [
    new winston.transports.Console(),
    ...(isProd ? [
      // Error log — only errors
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'error.log'),
        level: 'error',
        maxsize:  10 * 1024 * 1024,  // 10MB
        maxFiles: 5,
        tailable: true,
      }),
      // Combined log — everything
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'combined.log'),
        maxsize:  50 * 1024 * 1024,  // 50MB
        maxFiles: 10,
        tailable: true,
      }),
      // Audit log — security events only
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'audit.log'),
        level: 'warn',
        maxsize:  20 * 1024 * 1024,
        maxFiles: 30,  // keep 30 files for compliance
        tailable: true,
      }),
    ] : []),
  ],
});

// ── Morgan HTTP request logger ────────────────────────────────────────────
const morganMiddleware = morgan(
  isProd
    ? ':remote-addr :method :url :status :res[content-length] :response-time ms'
    : ':method :url :status :response-time ms',
  {
    stream: { write: (msg) => logger.http(msg.trim()) },
    // Skip health check noise
    skip: (req) => req.path === '/health',
  }
);

// ── Audit logger — structured security events ──────────────────────────────
function audit(event, data = {}) {
  logger.warn(`[AUDIT] ${event}`, {
    event,
    timestamp: new Date().toISOString(),
    ...data,
  });
}

// ── Replace console.* calls with winston ─────────────────────────────────
// Prevents raw console.log from bypassing the logging system in production
if (isProd) {
  console.log   = (...args) => logger.info(args.join(' '));
  console.error = (...args) => logger.error(args.join(' '));
  console.warn  = (...args) => logger.warn(args.join(' '));
  console.info  = (...args) => logger.info(args.join(' '));
}

module.exports = { logger, morganMiddleware, audit };
