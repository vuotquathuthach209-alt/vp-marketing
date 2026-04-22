/**
 * Knowledge admin routes — trigger rebuild, query semantic, manage wiki.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  rebuildEmbeddings, rebuildAllEmbeddings, semanticSearch, unifiedQuery,
  searchWiki, getWikiByNamespace,
} from '../services/knowledge-sync';

const router = Router();
router.use(authMiddleware);

/** GET /stats — tier 1/2/3 data summary */
router.get('/stats', (_req: AuthRequest, res) => {
  try {
    const t1 = {
      hotels: (db.prepare(`SELECT COUNT(*) as n FROM hotel_profile`).get() as any).n,
      rooms: (db.prepare(`SELECT COUNT(*) as n FROM hotel_room_catalog`).get() as any).n,
      availability_days: (db.prepare(`SELECT COUNT(*) as n FROM mkt_availability_cache`).get() as any).n,
    };
    const t2 = {
      total_chunks: (db.prepare(`SELECT COUNT(*) as n FROM hotel_knowledge_embeddings`).get() as any).n,
      by_type: db.prepare(`SELECT chunk_type, COUNT(*) as n FROM hotel_knowledge_embeddings GROUP BY chunk_type`).all(),
      by_hotel: db.prepare(`SELECT hotel_id, COUNT(*) as n FROM hotel_knowledge_embeddings GROUP BY hotel_id`).all(),
    };
    const t3 = {
      total: (db.prepare(`SELECT COUNT(*) as n FROM knowledge_wiki WHERE active = 1`).get() as any).n,
      by_ns: db.prepare(`SELECT namespace, COUNT(*) as n FROM knowledge_wiki WHERE active = 1 GROUP BY namespace`).all(),
    };
    res.json({ tier_1_facts: t1, tier_2_rag: t2, tier_3_wiki: t3 });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** POST /rebuild/:hotel_id — rebuild Tier 2 embeddings cho 1 hotel */
router.post('/rebuild/:hotel_id', async (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  try {
    const hid = parseInt(String(req.params.hotel_id), 10);
    const result = await rebuildEmbeddings(hid);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** POST /rebuild-all — rebuild tất cả active hotels */
router.post('/rebuild-all', async (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  try {
    const result = await rebuildAllEmbeddings();
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** GET /query?q=... — test unified query (Tier 1+2+3) */
router.get('/query', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const hotelIds = req.query.hotel_ids ? String(req.query.hotel_ids).split(',').map(n => parseInt(n, 10)) : undefined;
    const result = await unifiedQuery(q, hotelIds);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** GET /semantic?q=... — test Tier 2 RAG only */
router.get('/semantic', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const hitsArr = await semanticSearch(q, { topK: 10 });
    res.json({ query: q, hits: hitsArr });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Wiki CRUD */
router.get('/wiki', (_req: AuthRequest, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, namespace, slug, title, substr(content, 1, 200) as preview, tags, active, updated_at
       FROM knowledge_wiki ORDER BY namespace, slug`
    ).all();
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/wiki/:id', (req: AuthRequest, res) => {
  try {
    const row = db.prepare(`SELECT * FROM knowledge_wiki WHERE id = ?`).get(parseInt(String(req.params.id), 10));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/wiki', (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  try {
    const { namespace, slug, title, content, tags } = req.body || {};
    if (!namespace || !slug || !title || !content) {
      return res.status(400).json({ error: 'namespace + slug + title + content required' });
    }
    const now = Date.now();
    const existing = db.prepare(`SELECT id FROM knowledge_wiki WHERE namespace = ? AND slug = ?`).get(namespace, slug) as any;
    if (existing) {
      db.prepare(
        `UPDATE knowledge_wiki SET title = ?, content = ?, tags = ?, active = 1, updated_at = ? WHERE id = ?`
      ).run(title, content, tags || null, now, existing.id);
      return res.json({ ok: true, id: existing.id, updated: true });
    }
    const r = db.prepare(
      `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(namespace, slug, title, content, tags || null, now, now);
    res.json({ ok: true, id: r.lastInsertRowid, created: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

router.delete('/wiki/:id', (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  try {
    db.prepare(`UPDATE knowledge_wiki SET active = 0, updated_at = ? WHERE id = ?`)
      .run(Date.now(), parseInt(String(req.params.id), 10));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

export default router;
