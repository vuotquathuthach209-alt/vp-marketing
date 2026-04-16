import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { config } from '../config';

/**
 * SQLite Auto Backup — tạo backup hàng ngày, giữ 7 bản gần nhất
 */

const BACKUP_DIR = path.join(config.dataDir, 'backups');
const MAX_BACKUPS = 7;

export function runBackup(): string {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // WAL checkpoint trước khi backup
  db.pragma('wal_checkpoint(TRUNCATE)');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `db-backup-${timestamp}.sqlite`);

  // SQLite online backup
  db.backup(backupPath).then(() => {
    console.log(`[backup] Created: ${backupPath}`);
    cleanOldBackups();
  }).catch(e => {
    console.error('[backup] Failed:', e.message);
  });

  return backupPath;
}

function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db-backup-') && f.endsWith('.sqlite'))
      .sort()
      .reverse();

    // Keep only MAX_BACKUPS
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
      console.log(`[backup] Deleted old: ${files[i]}`);
    }
  } catch (e: any) {
    console.error('[backup] Cleanup error:', e.message);
  }
}

export function getBackupList(): Array<{ name: string; size_kb: number; created: string }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('db-backup-'))
    .sort().reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size_kb: Math.round(stat.size / 1024), created: stat.mtime.toISOString() };
    });
}
