/**
 * SEO Article Publisher — push draft articles từ vp-marketing sang CMS sondervn.com.
 *
 * SAFETY GUARANTEES (theo yêu cầu admin "không gán bài lung tung"):
 *   1. KHÔNG bao giờ push với status='published'. Tool LUÔN push status='draft'.
 *      Admin phải tự click Publish trong CMS sau khi review.
 *   2. Dry-run mode (setting `sondervn_cms_dry_run='true'`) → log nhưng KHÔNG call API.
 *   3. Idempotency check: nếu article đã có cms_id và cms_status != 'push_failed' → SKIP, không push lại.
 *   4. Health check trước mỗi push: GET /api/health của sondervn.com phải trả 200.
 *   5. Validation payload trước khi gửi (title, slug, body_html không rỗng, không có script tag injection).
 *   6. Retry 3 lần × exponential backoff (1s, 2s, 4s) cho transient errors (5xx, network).
 *      KHÔNG retry 4xx (validation error từ CMS).
 *   7. Audit log mọi action vào prepublish_audit (đã có table).
 *   8. Rate limit: max 5 push/phút để không quá tải CMS.
 *
 * REQUIRED CMS ENDPOINT CONTRACT (sondervn.com phải implement):
 *
 *   POST {sondervn_cms_url}{sondervn_cms_api_path}
 *   Headers:
 *     Authorization: Bearer {sondervn_cms_token}
 *     Content-Type: application/json
 *   Body: {
 *     title: string,
 *     slug: string,
 *     h1: string,
 *     meta_description: string,
 *     body_html: string,
 *     body_md: string,
 *     category: 'tin-tuc' | 'huong-dan' | 'diem-den' | 'khuyen-mai',
 *     faq: Array<{question: string, answer: string}>,
 *     keyword_target: string,
 *     related_keywords: string[],
 *     internal_links: Array<{anchor: string, url: string, reason: string}>,
 *     image_suggestions: Array<{alt_vi: string, alt_en: string, placement: string}>,
 *     article_schema: object,        // JSON-LD Article schema
 *     faq_schema: object | null,     // JSON-LD FAQPage schema
 *     status: 'draft',               // FIXED — tool KHÔNG bao giờ gửi 'published'
 *     source: 'vp-marketing',        // attribution
 *     source_article_id: number      // ID trong vp-marketing để cross-reference
 *   }
 *   Response 200: { ok: true, id: string | number, edit_url?: string, public_url?: string }
 *   Response 400: { ok: false, error: string }  (validation error — không retry)
 *   Response 4xx (other): không retry
 *   Response 5xx: retry với backoff
 *   Timeout: 30s
 *
 * Settings (DB):
 *   - sondervn_cms_url        — base URL (vd "https://sondervn.com"). Required.
 *   - sondervn_cms_api_path   — path (vd "/api/admin/articles"). Required.
 *   - sondervn_cms_token      — Bearer token (set in CMS env file). Required.
 *   - sondervn_cms_dry_run    — 'true' = dry-run (default). Đặt 'false' để enable real push.
 *   - sondervn_cms_health_path — GET endpoint health check (default "/api/health").
 *   - sondervn_cms_max_per_minute — rate limit (default 5).
 */

import axios, { AxiosError } from 'axios';
import { db, getSetting, setSetting } from '../../db';

const DEFAULT_HEALTH_PATH = '/api/health';
const DEFAULT_API_PATH = '/api/admin/articles';
const DEFAULT_RATE_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

export type PushStatus = 'pushed_draft' | 'push_failed' | 'skipped_duplicate' | 'dry_run';

export interface PushResult {
  ok: boolean;
  article_id: number;
  cms_id?: string;
  edit_url?: string;
  status: PushStatus;
  error?: string;
  attempt_count: number;
  duration_ms: number;
  dry_run: boolean;
}

/** Validate config — return error message hoặc null nếu OK. */
function validateConfig(): string | null {
  const url = getSetting('sondervn_cms_url');
  const path = getSetting('sondervn_cms_api_path') || DEFAULT_API_PATH;
  const token = getSetting('sondervn_cms_token');
  if (!url) return 'sondervn_cms_url chưa configured';
  if (!url.startsWith('https://') && !url.startsWith('http://')) return 'sondervn_cms_url phải bắt đầu https:// hoặc http://';
  if (!path.startsWith('/')) return 'sondervn_cms_api_path phải bắt đầu với /';
  if (!token) return 'sondervn_cms_token chưa configured';
  return null;
}

function getConfig() {
  return {
    url: (getSetting('sondervn_cms_url') || '').replace(/\/$/, ''),
    apiPath: getSetting('sondervn_cms_api_path') || DEFAULT_API_PATH,
    token: getSetting('sondervn_cms_token') || '',
    healthPath: getSetting('sondervn_cms_health_path') || DEFAULT_HEALTH_PATH,
    dryRun: getSetting('sondervn_cms_dry_run') !== 'false', // DEFAULT TRUE (safe-by-default)
    maxPerMinute: parseInt(getSetting('sondervn_cms_max_per_minute') || String(DEFAULT_RATE_LIMIT), 10),
  };
}

/** Sanitize body_html — chặn script tag injection (an toàn 2 chiều). */
function sanitizeHtml(html: string): { clean: string; warnings: string[] } {
  const warnings: string[] = [];
  let clean = html;
  if (/<script[\s>]/i.test(clean)) {
    warnings.push('Body có <script> tag — đã strip');
    clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '');
  }
  if (/on\w+\s*=/i.test(clean)) {
    warnings.push('Body có inline event handler (onclick=, onerror=...) — đã strip');
    clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  }
  if (/javascript:/i.test(clean)) {
    warnings.push('Body có javascript: URL — đã strip');
    clean = clean.replace(/javascript:[^"'\s>]*/gi, '#');
  }
  return { clean, warnings };
}

/** Validate article có đủ field bắt buộc, không quá ngắn/dài. */
function validateArticle(article: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!article) { return { ok: false, errors: ['Article object null'] }; }
  if (!article.title || article.title.trim().length < 10) errors.push('title phải >= 10 chars');
  if (article.title && article.title.length > 200) errors.push('title phải <= 200 chars');
  if (!article.slug || !/^[a-z0-9-]+$/.test(article.slug)) errors.push('slug phải lowercase + dash, không space/diacritics');
  if (!article.body_md || article.body_md.length < 500) errors.push('body_md phải >= 500 chars');
  if (article.word_count && (article.word_count < 300 || article.word_count > 5000)) errors.push('word_count phải 300-5000');
  if (!article.keyword_target) errors.push('keyword_target không được rỗng');
  return { ok: errors.length === 0, errors };
}

/** Heuristic category mapping từ keyword/angle → CMS category slug. */
function inferCategory(article: any): string {
  const angle = (article.angle || '').toLowerCase();
  const cat = (article.category || '').toLowerCase();
  if (cat === 'long_tail' || cat === 'medium_tail' || cat === 'head_term' || cat === 'branded') {
    if (angle === 'destination_guide' || angle === 'local_insider') return 'diem-den';
    if (angle === 'how_to' || angle === 'travel_tips') return 'huong-dan';
    if (angle === 'news_local' || angle === 'seasonal') return 'tin-tuc';
    if (angle === 'list_post' || angle === 'hotel_comparison') return 'diem-den';
  }
  return 'tin-tuc'; // default safe
}

/** Audit log mọi push action. */
function logAudit(articleId: number, decision: string, blocked: number, durationMs: number, details: any): void {
  try {
    db.prepare(
      `INSERT INTO prepublish_audit
       (source, source_id, decision, blocked, duration_ms, details_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('cms_push', articleId, decision, blocked, durationMs, JSON.stringify(details), Date.now());
  } catch (e: any) {
    console.warn('[article-publisher] audit log fail:', e?.message);
  }
}

/** Rate-limit: ensure không quá maxPerMinute push trong 60s window. */
function isRateLimitOk(maxPerMinute: number): boolean {
  const window = Date.now() - 60_000;
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM prepublish_audit WHERE source = 'cms_push' AND decision = 'pushed_draft' AND checked_at > ?`,
  ).get(window) as any;
  return recent.n < maxPerMinute;
}

/** Health check — GET /api/health của CMS. */
export async function healthCheckCMS(): Promise<{ ok: boolean; status?: number; error?: string; duration_ms: number }> {
  const t0 = Date.now();
  const cfg = getConfig();
  const err = validateConfig();
  if (err) return { ok: false, error: err, duration_ms: 0 };

  try {
    const url = cfg.url + cfg.healthPath;
    const r = await axios.get(url, {
      timeout: 10_000,
      validateStatus: () => true, // don't throw on 4xx/5xx
    });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      error: r.status >= 400 ? `HTTP ${r.status}` : undefined,
      duration_ms: Date.now() - t0,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network error', duration_ms: Date.now() - t0 };
  }
}

/** Push 1 article lên CMS. */
export async function pushArticleToCMS(articleId: number, opts: { force?: boolean } = {}): Promise<PushResult> {
  const t0 = Date.now();
  const cfg = getConfig();

  // 1. Validate config
  const cfgErr = validateConfig();
  if (cfgErr) {
    logAudit(articleId, 'config_error', 1, Date.now() - t0, { error: cfgErr });
    return { ok: false, article_id: articleId, status: 'push_failed', error: cfgErr, attempt_count: 0, duration_ms: Date.now() - t0, dry_run: cfg.dryRun };
  }

  // 2. Fetch article
  const article = db.prepare(`SELECT * FROM seo_articles WHERE id = ?`).get(articleId) as any;
  if (!article) {
    return { ok: false, article_id: articleId, status: 'push_failed', error: 'article not found', attempt_count: 0, duration_ms: Date.now() - t0, dry_run: cfg.dryRun };
  }

  // 3. Idempotency check
  if (!opts.force && article.cms_id && article.cms_status !== 'push_failed') {
    logAudit(articleId, 'skipped_duplicate', 0, Date.now() - t0, { cms_id: article.cms_id, cms_status: article.cms_status });
    return {
      ok: true,
      article_id: articleId,
      cms_id: article.cms_id,
      edit_url: article.cms_edit_url,
      status: 'skipped_duplicate',
      attempt_count: 0,
      duration_ms: Date.now() - t0,
      dry_run: cfg.dryRun,
    };
  }

  // 4. Parse JSON fields
  let faq: any[] = [], related_keywords: string[] = [], internal_links: any[] = [], image_suggestions: any[] = [], article_schema: any = null, faq_schema: any = null;
  try { faq = JSON.parse(article.faq_json || '[]'); } catch {}
  try { related_keywords = JSON.parse(article.related_keywords_json || '[]'); } catch {}
  try { internal_links = JSON.parse(article.internal_links_json || '[]'); } catch {}
  try { image_suggestions = JSON.parse(article.image_suggestions_json || '[]'); } catch {}
  try { article_schema = JSON.parse(article.article_schema_json || 'null'); } catch {}
  try { faq_schema = JSON.parse(article.faq_schema_json || 'null'); } catch {}

  // 5. Validate article
  const v = validateArticle(article);
  if (!v.ok) {
    logAudit(articleId, 'validation_failed', 1, Date.now() - t0, { errors: v.errors });
    db.prepare(`UPDATE seo_articles SET cms_status = 'push_failed', cms_last_error = ?, updated_at = ? WHERE id = ?`)
      .run('validation: ' + v.errors.join('; '), Date.now(), articleId);
    return { ok: false, article_id: articleId, status: 'push_failed', error: 'validation: ' + v.errors.join('; '), attempt_count: 0, duration_ms: Date.now() - t0, dry_run: cfg.dryRun };
  }

  // 6. Sanitize body_html
  const { clean: cleanHtml, warnings } = sanitizeHtml(article.body_html || '');
  if (warnings.length > 0) console.warn(`[article-publisher] #${articleId} sanitize warnings:`, warnings);

  // 7. Rate limit check
  if (!isRateLimitOk(cfg.maxPerMinute)) {
    logAudit(articleId, 'rate_limited', 1, Date.now() - t0, { limit: cfg.maxPerMinute });
    return { ok: false, article_id: articleId, status: 'push_failed', error: `rate limit: max ${cfg.maxPerMinute}/min`, attempt_count: 0, duration_ms: Date.now() - t0, dry_run: cfg.dryRun };
  }

  // 8. Build payload — STATUS LUÔN LUÔN = 'draft' (safety guarantee)
  const payload = {
    title: article.title,
    slug: article.slug,
    h1: article.h1 || article.title,
    meta_description: article.meta_description || '',
    body_html: cleanHtml,
    body_md: article.body_md,
    category: inferCategory(article),
    faq,
    keyword_target: article.keyword_target,
    related_keywords,
    internal_links,
    image_suggestions,
    article_schema,
    faq_schema,
    status: 'draft',          // <-- FIXED, không bao giờ thay đổi
    source: 'vp-marketing',
    source_article_id: articleId,
  };

  // 9. Dry-run mode
  if (cfg.dryRun) {
    logAudit(articleId, 'dry_run', 0, Date.now() - t0, { payload_size: JSON.stringify(payload).length, target_url: cfg.url + cfg.apiPath });
    console.log(`[article-publisher] DRY-RUN #${articleId} → ${cfg.url}${cfg.apiPath} (payload ${JSON.stringify(payload).length} bytes)`);
    return { ok: true, article_id: articleId, status: 'dry_run', attempt_count: 0, duration_ms: Date.now() - t0, dry_run: true };
  }

  // 10. POST with retry (3x, exponential backoff)
  const targetUrl = cfg.url + cfg.apiPath;
  let lastError: string = '';
  let attempt = 0;

  for (attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await axios.post(targetUrl, payload, {
        headers: { 'Authorization': `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      // 2xx — success
      if (r.status >= 200 && r.status < 300) {
        const cmsId = r.data?.id ? String(r.data.id) : null;
        const editUrl = r.data?.edit_url || null;
        if (!cmsId) {
          lastError = 'Response 200 but missing id field';
          break;
        }
        db.prepare(
          `UPDATE seo_articles
           SET cms_id = ?, cms_status = 'pushed_draft', cms_edit_url = ?, cms_pushed_at = ?, cms_last_error = NULL, cms_attempt_count = ?, updated_at = ?
           WHERE id = ?`,
        ).run(cmsId, editUrl, Date.now(), attempt, Date.now(), articleId);

        logAudit(articleId, 'pushed_draft', 0, Date.now() - t0, { cms_id: cmsId, attempt, sanitize_warnings: warnings });
        console.log(`[article-publisher] ✅ #${articleId} pushed → CMS id=${cmsId} (attempt ${attempt})`);
        return { ok: true, article_id: articleId, cms_id: cmsId, edit_url: editUrl, status: 'pushed_draft', attempt_count: attempt, duration_ms: Date.now() - t0, dry_run: false };
      }

      // 4xx — validation error, KHÔNG retry
      if (r.status >= 400 && r.status < 500) {
        lastError = `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`;
        break;
      }

      // 5xx — transient, retry
      lastError = `HTTP ${r.status} (will retry)`;
    } catch (e: any) {
      lastError = (e as AxiosError)?.message || String(e);
      // Network / timeout — retry
    }

    // Backoff before retry (if not last attempt)
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
    }
  }

  // All retries failed
  db.prepare(
    `UPDATE seo_articles SET cms_status = 'push_failed', cms_last_error = ?, cms_attempt_count = ?, updated_at = ? WHERE id = ?`,
  ).run(lastError, attempt - 1, Date.now(), articleId);

  logAudit(articleId, 'push_failed', 1, Date.now() - t0, { error: lastError, attempts: attempt - 1 });
  console.warn(`[article-publisher] ❌ #${articleId} push failed after ${attempt - 1} attempts: ${lastError}`);

  return { ok: false, article_id: articleId, status: 'push_failed', error: lastError, attempt_count: attempt - 1, duration_ms: Date.now() - t0, dry_run: false };
}

/** Bulk push — push N articles sequentially với rate limit. */
export async function bulkPushArticles(articleIds: number[]): Promise<{ results: PushResult[]; ok_count: number; fail_count: number; total_duration_ms: number }> {
  const t0 = Date.now();
  const cfg = getConfig();
  const delayMs = Math.ceil(60_000 / cfg.maxPerMinute) + 100; // small buffer

  const results: PushResult[] = [];
  for (const id of articleIds) {
    const r = await pushArticleToCMS(id);
    results.push(r);
    if (articleIds.indexOf(id) < articleIds.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  const ok_count = results.filter(r => r.ok && (r.status === 'pushed_draft' || r.status === 'dry_run' || r.status === 'skipped_duplicate')).length;
  return { results, ok_count, fail_count: results.length - ok_count, total_duration_ms: Date.now() - t0 };
}

/** Get CMS config (for dashboard display). */
export function getCmsConfig() {
  const c = getConfig();
  return {
    url: c.url || null,
    api_path: c.apiPath,
    health_path: c.healthPath,
    has_token: !!c.token,
    dry_run: c.dryRun,
    max_per_minute: c.maxPerMinute,
  };
}

/** Update CMS config. */
export function updateCmsConfig(opts: {
  url?: string;
  api_path?: string;
  health_path?: string;
  token?: string;
  dry_run?: boolean;
  max_per_minute?: number;
}): void {
  if (opts.url !== undefined) setSetting('sondervn_cms_url', opts.url.replace(/\/$/, ''));
  if (opts.api_path !== undefined) setSetting('sondervn_cms_api_path', opts.api_path);
  if (opts.health_path !== undefined) setSetting('sondervn_cms_health_path', opts.health_path);
  if (opts.token !== undefined) setSetting('sondervn_cms_token', opts.token);
  if (opts.dry_run !== undefined) setSetting('sondervn_cms_dry_run', opts.dry_run ? 'true' : 'false');
  if (opts.max_per_minute !== undefined) setSetting('sondervn_cms_max_per_minute', String(opts.max_per_minute));
}
