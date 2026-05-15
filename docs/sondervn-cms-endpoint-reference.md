# sondervn.com — CMS Article Receive Endpoint

> Reference implementation cho endpoint nhận bài SEO push từ vp-marketing.
> Anh paste đoạn code này vào backend sondervn.com (hoặc port sang Next.js API route).
>
> **Contract đã thỏa thuận** với tool vp-marketing:
> - Tool LUÔN push với `status='draft'` → admin tự click Publish trong CMS sau khi review
> - Tool retry 3 lần × exponential backoff cho 5xx, KHÔNG retry 4xx
> - Tool có rate limit 5/min sẵn → backend không cần xử lý DDoS phía mình
> - Tool có dry-run mode → khi test endpoint, dry-run KHÔNG call thật
> - Tool gửi `source: 'vp-marketing'` + `source_article_id` để cross-reference

---

## 1. Database schema (Postgres / MySQL)

```sql
CREATE TABLE articles (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,
  h1 VARCHAR(250),
  meta_description VARCHAR(200),
  body_html TEXT NOT NULL,
  body_md TEXT,
  category VARCHAR(50) NOT NULL DEFAULT 'tin-tuc',  -- tin-tuc | huong-dan | diem-den | khuyen-mai

  -- SEO metadata
  keyword_target VARCHAR(200),
  related_keywords_json TEXT,        -- JSON array
  internal_links_json TEXT,          -- JSON array
  image_suggestions_json TEXT,       -- JSON array
  faq_json TEXT,                     -- JSON array of {question, answer}

  -- JSON-LD schemas (render vào <head>)
  article_schema_json TEXT,
  faq_schema_json TEXT,

  -- Publishing state
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | published | archived
  published_at TIMESTAMP,
  author VARCHAR(100),

  -- Source attribution (vp-marketing integration)
  source VARCHAR(50) DEFAULT 'manual',          -- 'manual' | 'vp-marketing'
  source_article_id BIGINT,                     -- ID trong vp-marketing để cross-reference

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_articles_status ON articles(status, created_at DESC);
CREATE INDEX idx_articles_slug ON articles(slug);
CREATE INDEX idx_articles_source ON articles(source, source_article_id);
```

---

## 2. Express.js endpoint (Node.js)

```typescript
import express from 'express';
import { db } from './db'; // your DB client (pg, knex, prisma...)

const router = express.Router();

const PUBLISH_TOKEN = process.env.SONDERVN_PUBLISH_TOKEN!;
const ALLOWED_CATEGORIES = ['tin-tuc', 'huong-dan', 'diem-den', 'khuyen-mai'];

/* ─────────── Health check ─────────── */
router.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ─────────── Receive article from vp-marketing ─────────── */
router.post('/api/admin/articles', async (req, res) => {
  // 1. Auth: Bearer token
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '');
  if (!token || token !== PUBLISH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 2. Validate payload
  const b = req.body || {};
  const errors: string[] = [];
  if (!b.title || b.title.length < 10) errors.push('title required, >= 10 chars');
  if (!b.slug || !/^[a-z0-9-]+$/.test(b.slug)) errors.push('slug must be lowercase-dash');
  if (!b.body_html || b.body_html.length < 100) errors.push('body_html required, >= 100 chars');
  if (!b.category || !ALLOWED_CATEGORIES.includes(b.category)) errors.push('category invalid');
  if (b.status !== 'draft') errors.push('only status=draft is accepted from external sources');
  if (errors.length > 0) return res.status(400).json({ ok: false, error: errors.join('; ') });

  // 3. Check duplicate slug (auto-suffix if exists)
  let slug = b.slug;
  let suffix = 1;
  while (true) {
    const existing = await db.query('SELECT id FROM articles WHERE slug = $1', [slug]);
    if (existing.rows.length === 0) break;
    suffix++;
    slug = b.slug + '-' + suffix;
    if (suffix > 50) return res.status(400).json({ ok: false, error: 'slug collision exhausted' });
  }

  // 4. Insert
  try {
    const r = await db.query(`
      INSERT INTO articles (
        title, slug, h1, meta_description, body_html, body_md, category,
        keyword_target, related_keywords_json, internal_links_json,
        image_suggestions_json, faq_json, article_schema_json, faq_schema_json,
        status, source, source_article_id, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,NOW(),NOW())
      RETURNING id
    `, [
      b.title, slug, b.h1 || b.title, b.meta_description || '',
      b.body_html, b.body_md || '', b.category,
      b.keyword_target || null,
      JSON.stringify(b.related_keywords || []),
      JSON.stringify(b.internal_links || []),
      JSON.stringify(b.image_suggestions || []),
      JSON.stringify(b.faq || []),
      b.article_schema ? JSON.stringify(b.article_schema) : null,
      b.faq_schema ? JSON.stringify(b.faq_schema) : null,
      b.source || 'vp-marketing',
      b.source_article_id || null,
    ]);

    const id = r.rows[0].id;
    const editUrl = `https://sondervn.com/admin/articles/${id}/edit`;
    const publicUrl = `https://sondervn.com/tin-tuc/${slug}`;  // public URL (chưa visible vì status=draft)

    return res.status(200).json({
      ok: true,
      id,
      edit_url: editUrl,
      public_url: publicUrl, // sẽ visible sau khi admin click Publish trong CMS
    });
  } catch (e: any) {
    console.error('[articles] insert fail:', e);
    return res.status(500).json({ ok: false, error: 'database error: ' + e.message });
  }
});

export default router;
```

---

## 3. Next.js App Router (alternative cho Next.js)

```typescript
// app/api/admin/articles/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

const PUBLISH_TOKEN = process.env.SONDERVN_PUBLISH_TOKEN!;
const ALLOWED_CATEGORIES = ['tin-tuc', 'huong-dan', 'diem-den', 'khuyen-mai'];

export async function POST(req: NextRequest) {
  // Auth
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/, '');
  if (token !== PUBLISH_TOKEN) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const b = await req.json();

  // Validate
  if (b.status !== 'draft') {
    return NextResponse.json({ ok: false, error: 'only draft accepted' }, { status: 400 });
  }
  if (!ALLOWED_CATEGORIES.includes(b.category)) {
    return NextResponse.json({ ok: false, error: 'invalid category' }, { status: 400 });
  }

  // ... same INSERT logic as Express ...
  // (port logic from above)
}

// Health check
// app/api/health/route.ts
export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
```

---

## 4. Environment variables (.env on sondervn.com backend)

```bash
# Generate random 32-char token: openssl rand -hex 16
SONDERVN_PUBLISH_TOKEN=abc123def456_random_secret_token_here
```

---

## 5. Render trang public

Sau khi admin click Publish trong CMS, bài có `status='published'`. Trang `/tin-tuc/{slug}` cần:

```typescript
// app/tin-tuc/[slug]/page.tsx (Next.js)

export async function generateMetadata({ params }) {
  const a = await db.articles.findUnique({ where: { slug: params.slug, status: 'published' } });
  return {
    title: a.title,
    description: a.meta_description,
  };
}

export default async function ArticlePage({ params }) {
  const a = await db.articles.findUnique({ where: { slug: params.slug, status: 'published' } });
  if (!a) notFound();

  return (
    <>
      {/* JSON-LD schemas vào <head> */}
      {a.article_schema_json && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: a.article_schema_json }} />
      )}
      {a.faq_schema_json && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: a.faq_schema_json }} />
      )}

      <article>
        <h1>{a.h1 || a.title}</h1>
        <div dangerouslySetInnerHTML={{ __html: a.body_html }} />

        {/* FAQ section */}
        {a.faq_json && JSON.parse(a.faq_json).length > 0 && (
          <section className="faq">
            <h2>FAQ</h2>
            {JSON.parse(a.faq_json).map((f: any, i: number) => (
              <details key={i}>
                <summary>{f.question}</summary>
                <p>{f.answer}</p>
              </details>
            ))}
          </section>
        )}
      </article>
    </>
  );
}
```

---

## 6. CMS Admin UI

Anh có 2 lựa chọn UI để review/edit/publish:

### Option A — Build CMS UI tùy chỉnh
Tạo trang `/admin/articles` list + `/admin/articles/[id]/edit` editor (TinyMCE / Lexical / custom).

### Option B — Dùng adminjs / forest-admin / strapi-admin
Auto-generate admin UI cho bảng `articles` mất 30 phút.

### Option C — Đơn giản nhất: SQL inspector
Anh dùng pgAdmin / TablePlus → edit row trực tiếp → đặt `status='published'` + `published_at=NOW()`.

---

## 7. Test endpoint với curl

Sau khi anh deploy endpoint xong, test bằng:

```bash
curl -X POST https://sondervn.com/api/admin/articles \
  -H "Authorization: Bearer YOUR_PUBLISH_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test bài SEO từ vp-marketing",
    "slug": "test-bai-seo-tu-vp-marketing",
    "h1": "Test bài",
    "meta_description": "Test meta description SEO",
    "body_html": "<p>Đây là body HTML test, phải có ít nhất 100 ký tự để qua validation.</p><p>Paragraph 2.</p>",
    "body_md": "# Test\n\nbody markdown",
    "category": "tin-tuc",
    "status": "draft",
    "source": "vp-marketing",
    "source_article_id": 999
  }'
```

Expected response:
```json
{
  "ok": true,
  "id": 1,
  "edit_url": "https://sondervn.com/admin/articles/1/edit",
  "public_url": "https://sondervn.com/tin-tuc/test-bai-seo-tu-vp-marketing"
}
```

---

## 8. Sau khi anh deploy xong, cấu hình vp-marketing

Trên dashboard vp-marketing (`/admin/seo/dashboard` → tab Articles → click **⚙️ Config**):
- **URL**: `https://sondervn.com`
- **API path**: `/api/admin/articles`
- **Token**: paste `SONDERVN_PUBLISH_TOKEN` từ env file
- **DRY-RUN**: bật ON đầu tiên để test, sau đó tắt khi confirmed OK
- **Rate limit**: 5/min (default OK)

Sau đó click **🧪 Health check** → nếu OK → click **📤 Push CMS** trên 1 bài thử nghiệm.

---

## Câu hỏi thường gặp

**Q: Tool có push trùng không?**
A: KHÔNG. Tool check `cms_id` trước mỗi push. Nếu đã có → skip. Chỉ retry khi `cms_status = 'push_failed'`.

**Q: Nếu tôi sửa bài trong CMS, vp-marketing có update lại không?**
A: Hiện không. Sau khi push, tool dừng track. Anh là source of truth trong CMS. Tool chỉ push 1 chiều.

**Q: Có sync 2-chiều không?**
A: V2 sẽ có. Hiện V1 là 1-way push (vp-marketing → sondervn.com).

**Q: Bài bị lỗi push, tôi muốn retry?**
A: Vào dashboard → click bài có badge ❌ failed → button **📤 Push CMS** sẽ retry.

**Q: Tôi muốn DELETE bài đã push?**
A: Vào sondervn.com CMS → xóa trong đó. Vp-marketing sẽ giữ bài draft (anh có thể click "Push CMS" lại nếu muốn re-push).
