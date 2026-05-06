/**
 * V5 Real Footage upload routes
 *
 * Reference: skill sonder-content-v5 (60% real footage pillar)
 *
 * Endpoints:
 *   GET  /admin/footage         — list + filter
 *   POST /admin/footage/upload  — multipart upload (1+ files)
 *   GET  /admin/footage/:id     — detail
 *   DELETE /admin/footage/:id   — soft delete
 *   PATCH  /admin/footage/:id   — update tags (location, character, moment_tag)
 *
 * Storage: /var/sonder-real-footage/<filename>
 * Owned by vp-marketing process. Backup to S3 future.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../db';

const FOOTAGE_DIR = process.env.V5_FOOTAGE_DIR || '/var/sonder-real-footage';

// Ensure directory exists
try {
  fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
} catch {}

// Multer storage — preserve original filename + add timestamp
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FOOTAGE_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 80);
    cb(null, `${ts}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB per file
  fileFilter: (_req, file, cb) => {
    const ok = /\.(mp4|mov|m4v|webm|avi)$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new Error('Only video files allowed') as any);
  },
});

const router = Router();

/** GET /admin/footage — list + filter */
router.get('/', (req, res) => {
  const { location, character, moment, used_max } = req.query as any;
  let sql = `SELECT * FROM v5_footage WHERE 1=1`;
  const params: any[] = [];
  if (location) { sql += ` AND location = ?`; params.push(location); }
  if (character) { sql += ` AND character = ?`; params.push(character); }
  if (moment) { sql += ` AND moment_tag = ?`; params.push(moment); }
  if (used_max != null) { sql += ` AND used_count <= ?`; params.push(parseInt(used_max, 10)); }
  sql += ` ORDER BY uploaded_at DESC LIMIT 500`;

  const rows = db.prepare(sql).all(...params);
  res.json({ ok: true, count: rows.length, footage: rows });
});

/** POST /admin/footage/upload — multipart, 1+ video files */
router.post('/upload', upload.array('files', 30), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) return res.status(400).json({ error: 'no files' });

  const uploadedBy = (req as any).user?.email || req.headers['x-forwarded-email'] || 'admin';
  const meta = req.body || {};
  const now = Date.now();
  const inserted: any[] = [];

  for (const f of files) {
    try {
      // TODO: probe duration + dimensions via ffprobe (deferred — schema allows null)
      const r = db.prepare(
        `INSERT INTO v5_footage
         (filename, path, duration_sec, width, height,
          location, character, moment_tag, uploaded_by, uploaded_at,
          used_count, notes, created_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        f.originalname, f.path,
        meta.location || null, meta.character || null, meta.moment_tag || null,
        uploadedBy, now,
        meta.notes || null, now,
      );
      inserted.push({ id: r.lastInsertRowid, filename: f.originalname, path: f.path });
    } catch (e: any) {
      console.error('[v5-footage] insert fail:', e.message);
    }
  }

  res.json({ ok: true, uploaded: inserted.length, files: inserted });
});

/** GET /admin/footage/:id */
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM v5_footage WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, footage: row });
});

/** PATCH /admin/footage/:id — update tags */
router.patch('/:id', (req, res) => {
  const fields = ['location', 'character', 'moment_tag', 'notes'];
  const updates: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no fields' });
  params.push(req.params.id);
  const r = db.prepare(`UPDATE v5_footage SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true, changes: r.changes });
});

/** DELETE /admin/footage/:id — hard delete (file + DB row) */
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM v5_footage WHERE id = ?`).get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(row.path); } catch {}
  const r = db.prepare(`DELETE FROM v5_footage WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, deleted: r.changes });
});

/** GET /admin/footage/:id/file — stream video file (admin preview) */
router.get('/:id/file', (req, res) => {
  const row = db.prepare(`SELECT * FROM v5_footage WHERE id = ?`).get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!fs.existsSync(row.path)) return res.status(410).json({ error: 'file gone' });
  res.sendFile(row.path);
});

export default router;
