'use strict';
// lib/backup.js — Automated SQLite database backup
// Runs daily at 2 AM UTC, keeps last 7 daily + last 4 weekly backups
// In production, set BACKUP_DIR to a Railway Volume path or S3 URL

const fs   = require('fs');
const path = require('path');
const db   = require('../db');

const DB_PATH     = process.env.DB_PATH || path.join(__dirname, '..', 'sparkle.db');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_DAILY  = 7;   // keep 7 daily backups
const KEEP_WEEKLY = 4;   // keep 4 weekly backups

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function backupDatabase() {
  ensureBackupDir();

  if (!fs.existsSync(DB_PATH)) {
    console.warn('[BACKUP] Database file not found:', DB_PATH);
    return null;
  }

  const filename = `sparkle-${timestamp()}.db`;
  const dest     = path.join(BACKUP_DIR, filename);

  try {
    // Flush the WAL into the main database before copying so backups are consistent.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[BACKUP] WAL checkpoint failed, continuing with file copy:', err.message);
    }

    fs.copyFileSync(DB_PATH, dest);
    const stats   = fs.statSync(dest);
    const sizeMB  = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`[BACKUP] ✅ Database backed up → ${filename} (${sizeMB} MB)`);
    pruneOldBackups();
    return dest;
  } catch (err) {
    console.error('[BACKUP] ❌ Backup failed:', err.message);
    return null;
  }
}

function pruneOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('sparkle-') && f.endsWith('.db'))
      .sort()
      .reverse(); // newest first

    // Tag every 7th file as weekly, delete everything else beyond limits
    let daily = 0, weekly = 0;
    for (const file of files) {
      daily++;
      if (daily % 7 === 0) weekly++;

      const keep = daily <= KEEP_DAILY || weekly <= KEEP_WEEKLY;
      if (!keep) {
        fs.unlinkSync(path.join(BACKUP_DIR, file));
        console.log(`[BACKUP] 🗑  Pruned old backup: ${file}`);
      }
    }
  } catch (err) {
    console.error('[BACKUP] Prune error:', err.message);
  }
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('sparkle-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        filename: f,
        size_mb:  (stat.size / 1024 / 1024).toFixed(2),
        created:  stat.birthtime.toISOString(),
      };
    });
}

// Schedule daily backup at 2 AM UTC using a simple interval
// (Uses setInterval rather than a cron library to avoid adding a dependency)
function startScheduledBackups() {
  // Run once immediately on startup in production (to verify it works)
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => {
      console.log('[BACKUP] Running startup backup check...');
      backupDatabase();
    }, 10_000); // 10 seconds after startup
  }

  // Schedule daily at 2 AM UTC
  const msUntil2AM = (() => {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  })();

  setTimeout(() => {
    backupDatabase();
    // After the first run, repeat every 24 hours
    setInterval(backupDatabase, 24 * 60 * 60 * 1000);
  }, msUntil2AM);

  const hoursUntil = (msUntil2AM / 3_600_000).toFixed(1);
  console.log(`[BACKUP] ✅ Scheduled — next backup in ${hoursUntil} hours (daily at 2 AM UTC)`);
  console.log(`[BACKUP] Backup directory: ${BACKUP_DIR}`);
}

module.exports = { backupDatabase, listBackups, startScheduledBackups };
