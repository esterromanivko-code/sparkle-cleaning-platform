#!/usr/bin/env node
'use strict';
// scripts/backup.js — SQLite backup with WAL checkpointing
// Run manually: node scripts/backup.js
// Or schedule via Railway cron / external cron service

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH     = process.env.DB_PATH || path.join(__dirname, '..', 'sparkle.db');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '7'); // keep 7 days of backups

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function runBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const backupPath = path.join(BACKUP_DIR, `sparkle-${timestamp}.db`);

  console.log(`[BACKUP] Starting backup at ${new Date().toISOString()}`);
  console.log(`[BACKUP] Source: ${DB_PATH}`);
  console.log(`[BACKUP] Target: ${backupPath}`);

  try {
    // Open main DB
    const db = new DatabaseSync(DB_PATH);

    // WAL checkpoint — flush WAL to main DB before backup
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('[BACKUP] WAL checkpoint complete');

    // Get DB stats before backup
    const pageCount = db.prepare('PRAGMA page_count').get();
    const pageSize  = db.prepare('PRAGMA page_size').get();
    const sizeKB    = Math.round((pageCount.page_count * pageSize.page_size) / 1024);
    console.log(`[BACKUP] DB size: ${sizeKB}KB`);

    db.close();

    // Copy the file (SQLite backup method)
    fs.copyFileSync(DB_PATH, backupPath);
    console.log('[BACKUP] ✅ Backup file created successfully');

    // Verify the backup is readable
    const verifyDb = new DatabaseSync(backupPath, { readOnly: true });
    const userCount = verifyDb.prepare('SELECT COUNT(*) as cnt FROM users').get();
    verifyDb.close();
    console.log(`[BACKUP] ✅ Backup verified — ${userCount.cnt} users in backup`);

    // Rotate old backups — keep only MAX_BACKUPS most recent
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('sparkle-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(MAX_BACKUPS);
      for (const file of toDelete) {
        fs.unlinkSync(path.join(BACKUP_DIR, file));
        console.log(`[BACKUP] Deleted old backup: ${file}`);
      }
    }

    console.log(`[BACKUP] Done. Keeping ${Math.min(backups.length, MAX_BACKUPS)} backups.`);

    // Optional: upload to S3/R2 (uncomment and configure when ready)
    // await uploadToS3(backupPath, `backups/sparkle-${timestamp}.db`);

  } catch (err) {
    console.error('[BACKUP] ❌ Backup failed:', err.message);
    process.exit(1);
  }
}

runBackup();
