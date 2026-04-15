import { Router } from 'express';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { buildContext, getWikiStats } from '../services/wiki';

const router = Router();
router.use(authMiddleware);

const VALID_NS = ['business', 'product', 'campaign', 'faq', 'lesson'];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// List tất cả entry (có filter theo namespace)
router.get('/', (req, res) => {
  const ns = (req.query.namespace as string) || '';
  let rows;
  if (ns && VALID_NS.includes(ns)) {
    rows = db
      .prepare(
        `SELECT id, namespace, slug, title, content, tags, always_inject, active, updated_at
         FROM knowledge_wiki WHERE namespace = ? ORDER BY updated_at DESC`
      )
      .all(ns);
  } else {
    rows = db
      .prepare(
        `SELECT id, namespace, slug, title, content, tags, always_inject, active, updated_at
         FROM knowledge_wiki ORDER BY namespace ASC, updated_at DESC`
      )
      .all();
  }
  res.json(rows);
});

// Stats
router.get('/stats', (req, res) => {
  res.json(getWikiStats());
});

// Preview context cho 1 chủ đề (để user test trước khi đăng)
router.post('/preview', (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Thiếu topic' });
  const ctx = buildContext(topic);
  res.json({ context: ctx, length: ctx.length });
});

// Tạo mới
router.post('/', (req, res) => {
  const { namespace, slug, title, content, tags, always_inject } = req.body;
  if (!namespace || !VALID_NS.includes(namespace)) {
    return res.status(400).json({ error: `namespace phải là 1 trong: ${VALID_NS.join(', ')}` });
  }
  if (!title || !content) {
    return res.status(400).json({ error: 'Thiếu title hoặc content' });
  }
  const finalSlug = (slug && slug.trim()) || slugify(title);
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags || '[]';
  const now = Date.now();

  try {
    const result = db
      .prepare(
        `INSERT INTO knowledge_wiki
         (namespace, slug, title, content, tags, always_inject, active, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(namespace, finalSlug, title, content, tagsJson, always_inject ? 1 : 0, now, now);
    res.json({ ok: true, id: result.lastInsertRowid, slug: finalSlug });
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `Slug '${finalSlug}' đã tồn tại trong namespace '${namespace}'` });
    }
    res.status(500).json({ error: e?.message || 'DB error' });
  }
});

// Cập nhật
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, content, tags, always_inject, active } = req.body;
  const row = db.prepare(`SELECT id FROM knowledge_wiki WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });

  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags;

  db.prepare(
    `UPDATE knowledge_wiki SET
       title = COALESCE(?, title),
       content = COALESCE(?, content),
       tags = COALESCE(?, tags),
       always_inject = COALESCE(?, always_inject),
       active = COALESCE(?, active),
       updated_at = ?
     WHERE id = ?`
  ).run(
    title ?? null,
    content ?? null,
    tagsJson ?? null,
    always_inject === undefined ? null : always_inject ? 1 : 0,
    active === undefined ? null : active ? 1 : 0,
    Date.now(),
    id
  );
  res.json({ ok: true });
});

// Xóa
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM knowledge_wiki WHERE id = ?`).run(id);
  res.json({ ok: true });
});

export default router;
