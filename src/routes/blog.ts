/**
 * PUBLIC Blog routes — render bài SEO cho sondervn.com/tin-tuc.
 *
 * Architecture (Phương án A3):
 *   sondervn.com/tin-tuc/*  ──nginx reverse proxy──▶  vp-marketing:3000/blog/tin-tuc/*
 *
 * KHÔNG behind admin auth (public-facing). KHÔNG đụng OTA DB — chỉ đọc
 * seo_articles trong vp-marketing SQLite.
 *
 * Safety (theo yêu cầu admin "không gán bài lung tung"):
 *   - CHỈ render bài status='published'. Bài draft/reviewed KHÔNG hiện.
 *   - Admin phải click "Publish to blog" trên dashboard → set status='published'.
 *   - XSS-safe: body_html đã được sanitize ở article-publisher trước khi save;
 *     ở đây escape mọi user-facing text fields.
 *
 * SEO features:
 *   - Server-side rendered HTML (Google crawl được ngay)
 *   - <title>, <meta description>, canonical, OpenGraph, Twitter Card
 *   - JSON-LD Article + FAQPage schema trong <head>
 *   - Breadcrumb schema
 *   - sitemap.xml + robots.txt
 *   - Responsive mobile-first CSS
 */

import { Router } from 'express';
import { db, getSetting } from '../db';

const router = Router();

const SITE_NAME = 'Sonder Vietnam';
const SITE_URL = 'https://sondervn.com';
const BLOG_BASE = '/tin-tuc'; // public path (qua nginx proxy)

/* ───────── Helpers ───────── */

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString('vi-VN', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return ''; }
}

function readMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 200));
}

/* ── SEO internal-linking helpers (chống link bịa 404 + truyền link-juice về listing) ── */

// Các trang khu vực THẬT (app/khu-vuc/[area] trên sondervn.com) — allowlist đã verify 200.
const KNOWN_KHUVUC = new Set([
  'quan-1-sai-gon', 'bui-vien', 'pham-ngu-lao', 'co-giang', 'ben-thanh',
  'quan-3', 'tan-binh', 'sai-gon', 'da-lat', 'da-lat-trung-tam', 'da-nang',
]);

function deburr(s: any): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

// Map 1 từ khoá/chủ đề → URL nội bộ THẬT. Ưu tiên /khu-vuc đúng địa bàn, /apartment cho thuê tháng,
// mặc định /khach-san. Dùng cho cả "Chủ đề liên quan" lẫn fallback khi inject internal link.
function keywordToInternalUrl(keyword: string): string {
  const k = deburr(keyword);
  if (/(can ho|chdv|thue thang|serviced apartment|luu tru dai han|dai ngay)/.test(k)) return SITE_URL + '/apartment';
  if (/(quan 1|q1|q\.1|district 1)/.test(k)) return SITE_URL + '/khu-vuc/quan-1-sai-gon';
  if (/bui vien/.test(k)) return SITE_URL + '/khu-vuc/bui-vien';
  if (/pham ngu lao/.test(k)) return SITE_URL + '/khu-vuc/pham-ngu-lao';
  if (/co giang/.test(k)) return SITE_URL + '/khu-vuc/co-giang';
  if (/ben thanh/.test(k)) return SITE_URL + '/khu-vuc/ben-thanh';
  if (/(quan 3|q3|q\.3)/.test(k)) return SITE_URL + '/khu-vuc/quan-3';
  if (/(tan binh|san bay|tan son nhat)/.test(k)) return SITE_URL + '/khu-vuc/tan-binh';
  if (/da lat/.test(k)) return SITE_URL + '/khu-vuc/da-lat';
  if (/da nang/.test(k)) return SITE_URL + '/khu-vuc/da-nang';
  if (/(sai gon|tphcm|tp hcm|ho chi minh|hcm)/.test(k)) return SITE_URL + '/khu-vuc/sai-gon';
  return SITE_URL + '/khach-san';
}

// Validate URL nội bộ: chỉ chấp nhận host sondervn.com + path thuộc allowlist route THẬT.
// Trả URL chuẩn hoá nếu hợp lệ, null nếu không (loại /deals, /ho-chi-minh-city, /huong-dan-check-in...).
function validateInternalUrl(raw: any): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(String(raw), SITE_URL); } catch { return null; }
  if (u.hostname !== 'sondervn.com' && u.hostname !== 'www.sondervn.com') return null;
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const exact = new Set(['/khach-san', '/apartment', '/tin-tuc', '/dang-ky-khach-san', '/khu-vuc']);
  if (exact.has(p)) return SITE_URL + p;
  const m = p.match(/^\/khu-vuc\/([a-z0-9-]+)$/);
  if (m && KNOWN_KHUVUC.has(m[1]!)) return SITE_URL + p;
  return null;
}

/** Shared <head> + nav + footer wrapper. */
function pageShell(opts: {
  title: string;
  metaDesc: string;
  canonical: string;
  ogImage?: string;
  jsonLd?: string[];
  bodyHtml: string;
  isArticle?: boolean;
}): string {
  const ld = (opts.jsonLd || []).map(j => `<script type="application/ld+json">${j}</script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.metaDesc)}">
<link rel="canonical" href="${esc(opts.canonical)}">
<meta property="og:type" content="${opts.isArticle ? 'article' : 'website'}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.metaDesc)}">
<meta property="og:url" content="${esc(opts.canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
${opts.ogImage ? `<meta property="og:image" content="${esc(opts.ogImage)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.metaDesc)}">
${opts.ogImage ? `<meta name="twitter:image" content="${esc(opts.ogImage)}">` : ''}
<meta name="robots" content="index, follow, max-image-preview:large">
${ld}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;line-height:1.7;background:#fafafa}
  a{color:#1d4ed8;text-decoration:none}
  a:hover{text-decoration:underline}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px}
  .wrap-wide{max-width:1100px;margin:0 auto;padding:0 20px}
  header.site{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 0;position:sticky;top:0;z-index:10}
  header.site .wrap-wide{display:flex;align-items:center;justify-content:space-between}
  .logo{font-weight:800;font-size:20px;color:#b8860b;letter-spacing:.5px}
  .logo span{color:#1a1a1a}
  nav.top a{margin-left:20px;color:#444;font-size:15px;font-weight:500}
  .hero{background:linear-gradient(135deg,#1e3a8a,#1d4ed8);color:#fff;padding:48px 0;text-align:center}
  .hero h1{font-size:34px;font-weight:800;margin-bottom:10px}
  .hero p{font-size:16px;opacity:.9}
  .crumb{font-size:13px;color:#666;padding:16px 0}
  .crumb a{color:#666}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:22px;padding:30px 0}
  .card{background:#fff;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden;transition:box-shadow .2s}
  .card:hover{box-shadow:0 6px 24px rgba(0,0,0,.08)}
  .card .thumb{width:100%;height:190px;object-fit:cover;display:block;background:#eee}
  .card .body{padding:18px}
  .card .cat{display:inline-block;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;margin-bottom:10px}
  .cattabs{display:flex;gap:10px;padding:18px 0 4px}
  .cattabs a{padding:8px 18px;border-radius:24px;background:#fff;border:1px solid #ddd;color:#444;font-weight:500;font-size:14px}
  .cattabs a.on{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
  .partner-banner{background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #f59e0b;border-radius:12px;padding:16px 20px;margin:18px 0;font-size:15px}
  .partner-banner a{font-weight:700;white-space:nowrap}
  .cta-partner{background:linear-gradient(135deg,#1e3a8a,#1d4ed8);color:#fff;border-radius:14px;padding:28px;margin:36px 0;text-align:center}
  .cta-partner h3{font-size:22px;margin-bottom:10px;color:#fff}
  .cta-partner p{opacity:.92;margin-bottom:16px}
  .cta-partner a{display:inline-block;background:#fff;color:#1d4ed8;font-weight:700;padding:12px 28px;border-radius:24px}
  .article-cover img,.article-inline img{display:block}
  .card h2{font-size:18px;line-height:1.4;margin-bottom:8px}
  .card h2 a{color:#1a1a1a}
  .card .excerpt{font-size:14px;color:#555;margin-bottom:12px}
  .card .meta{font-size:12px;color:#999;display:flex;gap:12px}
  article.post{background:#fff;margin:24px 0 60px;padding:40px;border-radius:14px;border:1px solid #e8e8e8}
  article.post h1{font-size:32px;line-height:1.3;margin-bottom:16px;font-weight:800}
  article.post .post-meta{color:#888;font-size:14px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #eee}
  article.post h2{font-size:24px;margin:32px 0 14px;font-weight:700}
  article.post h3{font-size:19px;margin:24px 0 10px;font-weight:600}
  article.post p{margin-bottom:16px}
  article.post ul,article.post ol{margin:0 0 16px 24px}
  article.post li{margin-bottom:6px}
  article.post strong{font-weight:700}
  .faq{margin-top:40px;border-top:2px solid #eee;padding-top:28px}
  .faq h2{font-size:24px;margin-bottom:18px}
  .faq details{background:#f8f9fa;border-radius:10px;padding:14px 18px;margin-bottom:12px}
  .faq summary{font-weight:600;cursor:pointer;font-size:16px}
  .faq details p{margin-top:10px;color:#444}
  .related{margin-top:36px;background:#f0f7ff;border-radius:12px;padding:20px}
  .related h3{font-size:16px;margin-bottom:10px}
  .related a{display:inline-block;background:#fff;border:1px solid #cdd9ec;border-radius:20px;padding:6px 14px;margin:4px 6px 4px 0;font-size:13px}
  footer.site{background:#1a1a1a;color:#aaa;padding:36px 0;font-size:14px;text-align:center;margin-top:40px}
  footer.site a{color:#ddd}
  .empty{text-align:center;padding:80px 20px;color:#888}
  @media(max-width:640px){.hero h1{font-size:26px}article.post{padding:24px 18px}article.post h1{font-size:25px}}
</style>
</head>
<body>
<header class="site">
  <div class="wrap-wide">
    <a href="${SITE_URL}" class="logo">SONDER<span> VN</span></a>
    <nav class="top">
      <a href="${SITE_URL}/khach-san">Khách sạn</a>
      <a href="${SITE_URL}/apartment">Apartment</a>
      <a href="${BLOG_BASE}">Tin tức</a>
    </nav>
  </div>
</header>
${opts.bodyHtml}
<footer class="site">
  <div class="wrap-wide">
    <p>© ${new Date().getFullYear()} ${SITE_NAME} — Nền tảng đặt phòng khách sạn chọn lọc tại Việt Nam</p>
    <p style="margin-top:8px"><a href="${SITE_URL}">Trang chủ</a> · <a href="${BLOG_BASE}">Tin tức</a> · <a href="${SITE_URL}/lien-he">Liên hệ</a></p>
  </div>
</footer>
</body>
</html>`;
}

/* ───────── GET /blog/tin-tuc — listing page ───────── */

router.get(['/', '/tin-tuc'], (req, res) => {
  const cat = String((req.query.cat as string) || '').trim();
  const isPartner = cat === 'doi-tac';

  let sql = `SELECT id, title, slug, meta_description, keyword_target, word_count, category,
                    audience, cover_image_url, published_at, created_at
             FROM seo_articles WHERE status = 'published'`;
  const params: any[] = [];
  if (isPartner) { sql += ` AND category = 'doi-tac'`; }
  else if (cat) { sql += ` AND category = ?`; params.push(cat); }
  else { sql += ` AND (category != 'doi-tac' OR category IS NULL)`; } // mặc định: chỉ B2C du lịch
  sql += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT 100`;
  const articles = db.prepare(sql).all(...params) as any[];

  const heroTitle = isPartner ? 'Dành cho Đối tác' : 'Cẩm nang &amp; Câu chuyện';
  const heroSub = isPartner
    ? 'Tăng doanh thu phòng cùng Sonder — PMS miễn phí, chỉ trả phí khi có booking'
    : 'Kinh nghiệm du lịch, gợi ý hành trình và những câu chuyện từ khắp Việt Nam';

  let body = `<div class="hero"><div class="wrap-wide"><h1>${heroTitle}</h1><p>${heroSub}</p></div></div>`;
  body += `<div class="wrap-wide">`;
  // Category tabs
  body += `<div class="cattabs">`;
  body += `<a href="${BLOG_BASE}" class="${!isPartner ? 'on' : ''}">📰 Du lịch &amp; Lưu trú</a>`;
  body += `<a href="${BLOG_BASE}?cat=doi-tac" class="${isPartner ? 'on' : ''}">🤝 Dành cho Đối tác</a>`;
  body += `</div>`;
  body += `<div class="crumb"><a href="${SITE_URL}">Trang chủ</a> › ${isPartner ? 'Đối tác' : 'Tin tức'}</div>`;

  if (isPartner) {
    body += `<div class="partner-banner"><strong>Bạn là chủ khách sạn / homestay / căn hộ?</strong> Đăng property lên Sonder miễn phí — quản lý bằng PMS không tốn phí, chỉ trả phí khi có booking thật. <a href="${SITE_URL}/danh-cho-doi-tac">Đăng ký đối tác →</a></div>`;
  }

  if (articles.length === 0) {
    body += `<div class="empty"><h2>Chưa có bài viết</h2><p>Nội dung đang được chuẩn bị. Vui lòng quay lại sau.</p></div>`;
  } else {
    body += `<div class="grid">`;
    for (const a of articles) {
      const catLabel = ({ 'tin-tuc': 'Tin tức', 'huong-dan': 'Hướng dẫn', 'diem-den': 'Điểm đến', 'khuyen-mai': 'Khuyến mãi', 'doi-tac': 'Đối tác' } as any)[a.category] || 'Tin tức';
      body += `<div class="card">`;
      if (a.cover_image_url) body += `<a href="${BLOG_BASE}/${esc(a.slug)}"><img class="thumb" src="${esc(a.cover_image_url)}" alt="${esc(a.title)}" loading="lazy"/></a>`;
      body += `<div class="body">`;
      body += `<span class="cat">${esc(catLabel)}</span>`;
      body += `<h2><a href="${BLOG_BASE}/${esc(a.slug)}">${esc(a.title)}</a></h2>`;
      body += `<p class="excerpt">${esc((a.meta_description || '').slice(0, 140))}</p>`;
      body += `<div class="meta"><span>${fmtDate(a.published_at || a.created_at)}</span><span>${readMinutes(a.word_count)} phút đọc</span></div>`;
      body += `</div></div>`;
    }
    body += `</div>`;
  }
  body += `</div>`;

  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${SITE_NAME} — Tin tức`,
    url: SITE_URL + BLOG_BASE,
    description: 'Kinh nghiệm du lịch, gợi ý hành trình và những câu chuyện từ khắp Việt Nam',
  });

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600'); // 10 min CDN/browser cache
  res.send(pageShell({
    title: `Tin tức &amp; Cẩm nang du lịch | ${SITE_NAME}`,
    metaDesc: 'Kinh nghiệm du lịch, gợi ý khách sạn giá tốt, hành trình khắp Việt Nam từ Sonder.',
    canonical: SITE_URL + BLOG_BASE,
    jsonLd: [ld],
    bodyHtml: body,
  }));
});

/* ───────── GET /blog/sitemap.xml ───────── */

router.get('/sitemap.xml', (_req, res) => {
  const articles = db.prepare(
    `SELECT slug, COALESCE(published_at, updated_at, created_at) AS lastmod
     FROM seo_articles WHERE status = 'published' ORDER BY lastmod DESC LIMIT 5000`,
  ).all() as any[];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url><loc>${SITE_URL}${BLOG_BASE}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  for (const a of articles) {
    const d = new Date(a.lastmod || Date.now()).toISOString().slice(0, 10);
    xml += `  <url><loc>${SITE_URL}${BLOG_BASE}/${esc(a.slug)}</loc><lastmod>${d}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
  }
  xml += '</urlset>';

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(xml);
});

/* ───────── GET /blog/tin-tuc/:slug — article detail ───────── */

router.get('/tin-tuc/:slug', (req, res) => {
  const slug = req.params.slug;
  const a = db.prepare(
    `SELECT * FROM seo_articles WHERE slug = ? AND status = 'published'`,
  ).get(slug) as any;

  if (!a) {
    res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(pageShell({
      title: 'Không tìm thấy bài viết | ' + SITE_NAME,
      metaDesc: 'Bài viết không tồn tại hoặc đã bị gỡ.',
      canonical: SITE_URL + BLOG_BASE,
      bodyHtml: `<div class="wrap"><div class="empty"><h1>404</h1><p>Bài viết không tồn tại. <a href="${BLOG_BASE}">← Về trang Tin tức</a></p></div></div>`,
    }));
    return;
  }

  // Parse JSON fields safely
  let faq: any[] = [], related: string[] = [], articleSchema: any = null, faqSchema: any = null;
  try { faq = JSON.parse(a.faq_json || '[]'); } catch {}
  try { related = JSON.parse(a.related_keywords_json || '[]'); } catch {}
  try { articleSchema = JSON.parse(a.article_schema_json || 'null'); } catch {}
  try { faqSchema = JSON.parse(a.faq_schema_json || 'null'); } catch {}

  const canonical = `${SITE_URL}${BLOG_BASE}/${a.slug}`;
  const isPartner = a.category === 'doi-tac';
  const catLabel = ({ 'tin-tuc': 'Tin tức', 'huong-dan': 'Hướng dẫn', 'diem-den': 'Điểm đến', 'khuyen-mai': 'Khuyến mãi', 'doi-tac': 'Đối tác' } as any)[a.category] || 'Tin tức';
  const backLink = isPartner ? `${BLOG_BASE}?cat=doi-tac` : BLOG_BASE;
  const backLabel = isPartner ? 'Đối tác' : 'Tin tức';

  // Vá Article JSON-LD ngay ở render-time (sửa CẢ 73 bài cũ + bài mới):
  //  - image: bắt buộc cho Article rich result (trước đây bỏ trống)
  //  - url/mainEntityOfPage: về canonical /tin-tuc/<slug> (trước hardcode /blog/<slug> = 404)
  //  - dateModified: tín hiệu tươi cho Google
  if (articleSchema && typeof articleSchema === 'object') {
    if (a.cover_image_url && !articleSchema.image) articleSchema.image = [a.cover_image_url];
    articleSchema.url = canonical;
    articleSchema.mainEntityOfPage = canonical;
    const modTs = a.updated_at || a.published_at || a.created_at;
    if (modTs) { try { articleSchema.dateModified = new Date(modTs).toISOString().slice(0, 10); } catch {} }
  }

  let body = `<div class="wrap">`;
  body += `<div class="crumb"><a href="${SITE_URL}">Trang chủ</a> › <a href="${backLink}">${backLabel}</a> › ${esc(a.title.slice(0, 50))}</div>`;
  body += `<article class="post">`;
  body += `<span class="card" style="display:inline-block;background:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;border:none;margin-bottom:14px">${esc(catLabel)}</span>`;
  body += `<h1>${esc(a.h1 || a.title)}</h1>`;
  body += `<div class="post-meta">Sonder Team · ${fmtDate(a.published_at || a.created_at)} · ${readMinutes(a.word_count)} phút đọc</div>`;

  // body_html đã có cover + inline images inject sẵn từ article-cron (qua injectImagesIntoHtml).
  // Đã sanitize ở article-publisher. Render trực tiếp.
  body += `<div class="content">${a.body_html || ('<p>' + esc(a.body_md || '') + '</p>')}</div>`;

  // B2B partner: CTA banner đậm cuối bài
  if (isPartner) {
    body += `<div class="cta-partner"><h3>Sẵn sàng tăng doanh thu phòng?</h3><p>Đăng ký đối tác Sonder miễn phí — PMS quản lý không tốn phí, chỉ trả phí khi có booking thật.</p><a href="${SITE_URL}/danh-cho-doi-tac">Đăng ký đối tác ngay →</a></div>`;
  }

  // ── Internal link injection (CÓ GATE: setting seo_blog_internal_links='true') ──
  // Thêm khối "Gợi ý chỗ ở tại Sonder" với 2-3 link nội bộ ĐÃ VALIDATE (chống 404)
  // → truyền link-juice về /khu-vuc + /khach-san + /apartment (đòn bẩy index cho domain mới).
  // Mặc định TẮT → chờ user duyệt bài mẫu rồi bật (đổi nội dung hiển thị của bài tự-đăng).
  if (getSetting('seo_blog_internal_links') === 'true') {
    const links: { url: string; anchor: string }[] = [];
    try {
      const rawLinks = JSON.parse(a.internal_links_json || '[]');
      for (const it of (Array.isArray(rawLinks) ? rawLinks : [])) {
        const v = validateInternalUrl(it?.url);
        if (v && !links.some((l) => l.url === v)) {
          const anchor = String(it?.anchor || '').trim().slice(0, 70) || 'Xem chỗ ở Sonder';
          links.push({ url: v, anchor });
        }
        if (links.length >= 3) break;
      }
    } catch {}
    // Fallback: <2 link hợp lệ → bù bằng link suy ra từ từ khoá + loại sản phẩm (luôn hợp lệ).
    if (links.length < 2) {
      const derived = keywordToInternalUrl(a.keyword_target || a.title || '');
      if (!links.some((l) => l.url === derived)) links.push({ url: derived, anchor: 'Xem khách sạn & chỗ ở Sonder phù hợp' });
      const generic = isPartner ? SITE_URL + '/dang-ky-khach-san' : SITE_URL + '/khach-san';
      if (links.length < 2 && !links.some((l) => l.url === generic)) links.push({ url: generic, anchor: 'Khám phá tất cả chỗ ở trên Sonder' });
    }
    if (links.length > 0) {
      body += `<div class="related" style="background:#f0fdf4;border:1px solid #bbf7d0"><h3>Gợi ý chỗ ở tại Sonder</h3>`;
      for (const l of links.slice(0, 3)) {
        body += `<a href="${esc(l.url)}" style="background:#fff;border-color:#86efac">${esc(l.anchor)} →</a>`;
      }
      body += `</div>`;
    }
  }

  // FAQ section
  if (faq.length > 0) {
    body += `<div class="faq"><h2>Câu hỏi thường gặp</h2>`;
    for (const f of faq) {
      body += `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`;
    }
    body += `</div>`;
  }

  // Related keywords (internal SEO)
  if (related.length > 0) {
    body += `<div class="related"><h3>Chủ đề liên quan</h3>`;
    for (const k of related.slice(0, 10)) {
      // Deep-link về trang listing/khu-vuc THẬT theo từ khoá (trước đây mọi chip đều trỏ /tin-tuc = link chết).
      body += `<a href="${esc(keywordToInternalUrl(k))}">${esc(k)}</a>`;
    }
    body += `</div>`;
  }

  body += `<div style="margin-top:32px"><a href="${backLink}">← Xem tất cả bài ${esc(backLabel.toLowerCase())}</a></div>`;
  body += `</article></div>`;

  // JSON-LD: Article + FAQ + Breadcrumb
  const jsonLd: string[] = [];
  if (articleSchema) jsonLd.push(JSON.stringify(articleSchema));
  if (faqSchema) jsonLd.push(JSON.stringify(faqSchema));
  jsonLd.push(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Tin tức', item: SITE_URL + BLOG_BASE },
      { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
    ],
  }));

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(pageShell({
    title: `${a.title} | ${SITE_NAME}`,
    metaDesc: a.meta_description || a.title,
    canonical,
    ogImage: a.cover_image_url || undefined,
    jsonLd,
    bodyHtml: body,
    isArticle: true,
  }));
});

export default router;
