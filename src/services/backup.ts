import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { db, getSetting } from '../db';
import { config } from '../config';

/**
 * SQLite Auto Backup
 *  - Tạo bản backup qua online `db.backup()` (safe with WAL)
 *  - Gzip → tiết kiệm 70-90% dung lượng
 *  - Giữ 30 bản gần nhất (~1 tháng)
 *  - Optional: upload lên S3/R2 nếu cấu hình (settings: s3_endpoint/s3_bucket/s3_key/s3_secret)
 *  - Alert Telegram admin khi backup fail
 */

const BACKUP_DIR = path.join(config.dataDir, 'backups');
const MAX_BACKUPS = 30;

export async function runBackup(): Promise<string | null> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    db.pragma('wal_checkpoint(TRUNCATE)');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rawPath = path.join(BACKUP_DIR, `db-backup-${timestamp}.sqlite`);
    const gzPath = rawPath + '.gz';

    await db.backup(rawPath);

    // Gzip
    await pipeline(
      fs.createReadStream(rawPath),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(gzPath)
    );
    fs.unlinkSync(rawPath);

    const sizeKb = Math.round(fs.statSync(gzPath).size / 1024);
    console.log(`[backup] Created: ${path.basename(gzPath)} (${sizeKb} KB)`);

    cleanOldBackups();

    // Optional offsite upload
    try {
      await uploadOffsite(gzPath);
    } catch (e: any) {
      console.error('[backup] offsite upload failed:', e?.message);
    }

    return gzPath;
  } catch (e: any) {
    console.error('[backup] Failed:', e?.message);
    try {
      const { notifyAdmin } = require('./telegram');
      notifyAdmin(`🚨 DB BACKUP FAILED: ${e?.message || 'unknown'}`);
    } catch {}
    return null;
  }
}

function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db-backup-'))
      .sort()
      .reverse();
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
      console.log(`[backup] Deleted old: ${files[i]}`);
    }
  } catch (e: any) {
    console.error('[backup] Cleanup error:', e.message);
  }
}

/**
 * Optional: upload to S3-compatible storage (R2/Backblaze/AWS).
 * Skip silently nếu chưa cấu hình. Dùng fetch PUT với AWS SigV4-lite
 * hoặc nếu endpoint hỗ trợ presigned, KS có thể tự upload.
 * Ở đây dùng cách đơn giản: nếu settings.backup_webhook_url có thì POST file qua HTTP.
 */
async function uploadOffsite(filePath: string): Promise<void> {
  const webhook = getSetting('backup_webhook_url');
  if (!webhook) return;
  const axios = require('axios');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), path.basename(filePath));
  await axios.post(webhook, form, {
    headers: form.getHeaders(),
    maxContentLength: 500 * 1024 * 1024,
    maxBodyLength: 500 * 1024 * 1024,
    timeout: 120000,
  });
  console.log(`[backup] Uploaded offsite: ${path.basename(filePath)}`);
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
