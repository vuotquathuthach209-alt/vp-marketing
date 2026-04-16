import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { buildContext, getWikiStats } from '../services/wiki';
import { embed, encodeEmbedding, getEmbedderInfo, EMBED_MODEL } from '../services/embedder';

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

async function embedAndStore(id: number, title: string, content: string) {
  const vec = await embed(`${title}\n${content}`);
  if (!vec) return false;
  db.prepare(
    `UPDATE knowledge_wiki SET embedding = ?, embedding_model = ? WHERE id = ?`
  ).run(encodeEmbedding(vec), EMBED_MODEL, id);
  return true;
}

// List — hotel_id isolated
router.get('/', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const ns = (req.query.namespace as string) || '';
  let rows;
  if (ns && VALID_NS.includes(ns)) {
    rows = db
      .prepare(
        `SELECT id, namespace, slug, title, content, tags, always_inject, active, updated_at,
                (embedding IS NOT NULL) as has_embedding
         FROM knowledge_wiki WHERE namespace = ? AND hotel_id = ? ORDER BY updated_at DESC`
      )
      .all(ns, hotelId);
  } else {
    rows = db
      .prepare(
        `SELECT id, namespace, slug, title, content, tags, always_inject, active, updated_at,
                (embedding IS NOT NULL) as has_embedding
         FROM knowledge_wiki WHERE hotel_id = ? ORDER BY namespace ASC, updated_at DESC`
      )
      .all(hotelId);
  }
  res.json(rows);
});

router.get('/stats', (req, res) => {
  res.json({ ...getWikiStats(), embedder: getEmbedderInfo() });
});

// Preview context (async vì semantic embed)
router.post('/preview', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Thiếu topic' });
  try {
    const ctx = await buildContext(topic);
    res.json({ context: ctx, length: ctx.length, semantic: getEmbedderInfo().ready });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Preview error' });
  }
});

// Backfill embeddings cho các entry chưa có
router.post('/embed-all', async (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, content FROM knowledge_wiki
       WHERE active = 1 AND embedding IS NULL`
    )
    .all() as { id: number; title: string; content: string }[];

  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    const success = await embedAndStore(r.id, r.title, r.content);
    if (success) ok++;
    else fail++;
  }
  res.json({ ok, fail, total: rows.length });
});

// Tạo mới — inject hotel_id
router.post('/', async (req: AuthRequest, res) => {
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
    const hotelId = getHotelId(req);
    const result = db
      .prepare(
        `INSERT INTO knowledge_wiki
         (namespace, slug, title, content, tags, always_inject, active, hotel_id, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(namespace, finalSlug, title, content, tagsJson, always_inject ? 1 : 0, hotelId, now, now);
    const id = Number(result.lastInsertRowid);
    // Auto-embed (best effort — không block response nếu embed fail)
    embedAndStore(id, title, content).catch((e) => console.warn('[wiki] embed fail:', e?.message));
    res.json({ ok: true, id, slug: finalSlug });
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `Slug '${finalSlug}' đã tồn tại trong namespace '${namespace}'` });
    }
    res.status(500).json({ error: e?.message || 'DB error' });
  }
});

// Cập nhật
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  const { title, content, tags, always_inject, active } = req.body;
  const row = db.prepare(`SELECT id, title, content FROM knowledge_wiki WHERE id = ?`).get(id) as
    | { id: number; title: string; content: string }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });

  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags;
  const contentChanged = content && content !== row.content;
  const titleChanged = title && title !== row.title;

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

  // Re-embed nếu title/content đổi
  if (contentChanged || titleChanged) {
    const newTitle = title ?? row.title;
    const newContent = content ?? row.content;
    embedAndStore(id, newTitle, newContent).catch((e) =>
      console.warn('[wiki] re-embed fail:', e?.message)
    );
  }
  res.json({ ok: true });
});

router.delete('/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(req.params.id as string, 10);
  db.prepare(`DELETE FROM knowledge_wiki WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

export default router;
