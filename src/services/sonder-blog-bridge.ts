/**
 * Sonder Blog Bridge — bot mkt push blog post → Sonder OTA web
 *
 * Pushes news article (sau khi đã publish FB thành công) lên Sondervn blog
 * qua endpoint POST /api/inbound/marketing-content (HMAC-SHA256).
 *
 * Non-blocking: failure không kill FB publish flow.
 *
 * Env required:
 *   SONDERVN_BASE_URL          — https://sondervn.com (or http://localhost:3000 for dev)
 *   SONDERVN_MKT_API_SECRET    — same value as OTA web .env MKT_API_SECRET
 */
import axios from 'axios';
import crypto from 'crypto';

const SONDERVN_BASE = process.env.SONDERVN_BASE_URL || 'https://sondervn.com';
const SECRET = process.env.SONDERVN_MKT_API_SECRET || '';
const ENABLED = !!SECRET && process.env.SONDERVN_BLOG_BRIDGE_ENABLED !== 'false';

export interface BlogPostPayload {
  slug: string;
  title: string;
  excerpt?: string | null;
  content: string;
  coverImage?: string | null;
  category?: string;       // default 'tin-tuc'
  tags?: string[];
  author?: string;         // default 'Bot Marketing'
  status?: 'draft' | 'published' | 'archived';
  isFeatured?: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  publishedAt?: string | null;  // ISO
}

function slugify(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'bai-viet';
}

function makeSignature(rawBody: string): string {
  return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

export async function pushBlogPost(
  payload: BlogPostPayload,
  opts: { idempotencyKey?: string; kind?: 'blog.upsert' | 'blog.publish' | 'blog.unpublish' | 'blog.delete' } = {}
): Promise<{ ok: boolean; action?: string; id?: string; deduplicated?: boolean; error?: string }> {
  if (!ENABLED) {
    return { ok: false, error: 'bridge_disabled' };
  }

  // Auto-fill required defaults
  const finalSlug = payload.slug || slugify(payload.title);
  const envelope = {
    envelope: {
      source: 'bot-mkt' as const,
      type: 'marketing-content',
      idempotency_key: opts.idempotencyKey || ('blog-' + finalSlug + '-' + Date.now()),
      emitted_at: new Date().toISOString(),
      contract_version: '1.0',
    },
    kind: opts.kind || 'blog.upsert',
    payload: {
      ...payload,
      slug: finalSlug,
      status: payload.status || 'published',
      author: payload.author || 'Bot Marketing',
      category: payload.category || 'tin-tuc',
    },
  };

  const rawBody = JSON.stringify(envelope);
  const sig = makeSignature(rawBody);

  try {
    const resp = await axios.post(
      `${SONDERVN_BASE}/api/inbound/marketing-content`,
      rawBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Mkt-Signature': sig,
        },
        timeout: 30_000,
      }
    );
    if (resp.data?.success) {
      return {
        ok: true,
        action: resp.data.action,
        id: resp.data.id,
        deduplicated: resp.data.deduplicated,
      };
    }
    return { ok: false, error: resp.data?.error || 'unknown' };
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || 'network';
    const status = e?.response?.status || 0;
    return { ok: false, error: `${status}: ${msg}` };
  }
}

export function isEnabled(): boolean {
  return ENABLED;
}
