/**
 * SEO Article Images — chọn ảnh Drive cho bài, KHÔNG trùng, KHÔNG vi phạm bản quyền.
 *
 * Pipeline:
 *   1. tagFootageImage()  — Gemini Vision phân loại ảnh (scene/mood/location). Cache.
 *   2. pickImagesForArticle() — chọn N ảnh:
 *        a. CHƯA dùng trong 60 ngày (dedup qua seo_article_images)
 *        b. scene phù hợp content_pillar (bedroom→property, nature→destination...)
 *        c. QUA copyright firewall (phash + blacklist) — tái dùng verifier đã có
 *        d. record vào seo_article_images để bài sau không trùng
 *   3. getPublicUrl() — path /var/sonder-real-footage/X → /v5t-footage/X (nginx alias)
 *
 * Nguồn ảnh: v5_footage (167 ảnh real Sonder từ Drive — KHÔNG bản quyền vì ảnh
 * gốc của Sonder). Copyright firewall vẫn check để chắc chắn 2 lớp.
 */

import fs from 'fs';
import axios from 'axios';
import { db, getSetting } from '../../db';

const FOOTAGE_DIR = process.env.V5_FOOTAGE_DIR || '/var/sonder-real-footage';
const DEDUP_WINDOW_DAYS = 60;

export type ContentPillar = 'homestay' | 'hotel' | 'apartment' | 'destination' | 'tips' | 'insider' | 'partner';

interface VisionTag {
  scene: string;       // bedroom | view | exterior | food | area | lobby | bathroom | pool | other
  subjects: string[];
  mood: string;        // cozy | luxury | nature | urban | minimalist | vibrant | serene
  location_hint: string;
}

const VISION_PROMPT = `Phân loại ảnh này cho bài blog du lịch/lưu trú. Output JSON:
{
  "scene": "<bedroom|view|exterior|food|area|lobby|bathroom|pool|other>",
  "subjects": ["<2-4 vật thể/cảnh chính trong ảnh>"],
  "mood": "<cozy|luxury|nature|urban|minimalist|vibrant|serene>",
  "location_hint": "<đoán bối cảnh: beach|mountain|city|countryside|indoor — hoặc '' nếu không rõ>"
}
QUY TẮC: chỉ mô tả NHỮNG GÌ THẤY trong ảnh. Không bịa tên địa danh/thương hiệu.`;

/** Resolve absolute path từ v5_footage.path (có thể là full path hoặc filename). */
function resolveLocalPath(footagePath: string): string {
  if (footagePath.startsWith('/')) return footagePath;
  return `${FOOTAGE_DIR}/${footagePath.split('/').pop()}`;
}

/** Convert local footage path → public URL (nginx alias /v5t-footage/). */
export function getPublicImageUrl(footagePath: string): string {
  const fn = footagePath.split('/').pop();
  return `https://sondervn.com/v5t-footage/${fn}`;
}

/** Bỏ dấu tiếng Việt → ASCII (để search ảnh stock khớp hơn). */
function stripVi(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/**
 * Lấy ảnh STOCK MIỄN PHÍ bản quyền (Pexels → Pixabay fallback) theo từ khóa điểm đến.
 * Dùng cho bài điểm đến (du lịch X) — own footage không có cảnh nơi đó.
 * Pexels/Pixabay License: dùng thương mại OK, không cần ghi nguồn, cho hotlink.
 */
export async function fetchStockImages(query: string, count: number): Promise<string[]> {
  // Làm sạch query: bỏ cụm không phải địa danh + bỏ dấu + thêm "vietnam"
  let q = stripVi(query).toLowerCase()
    .replace(/\b(du lich|an gi o|an gi|kinh nghiem|lich trinh|dia diem|review|cam nang|co gi choi|co gi|mua nao dep|tu tuc|gia re|o dau|ngay|dem|nhat dinh phai thu|song ao|check ?in|top|ngon)\b/g, ' ')
    .replace(/[0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q.length < 2) q = 'vietnam travel';
  const term = encodeURIComponent(q + ' vietnam');
  const out: string[] = [];

  // 1) Pexels (nhiều ảnh, ưu tiên)
  try {
    const key = getSetting('pexels_api_key');
    if (key) {
      const r = await axios.get(
        `https://api.pexels.com/v1/search?query=${term}&per_page=${Math.min(count + 4, 15)}&orientation=landscape`,
        { headers: { Authorization: key }, timeout: 15_000 });
      for (const p of (r.data?.photos || [])) {
        const u = p?.src?.large || p?.src?.landscape || p?.src?.original;
        if (u && !out.includes(u)) out.push(u);
        if (out.length >= count) break;
      }
    }
  } catch (e: any) { console.warn('[stock] pexels fail:', e?.response?.status || e?.message); }

  // 2) Pixabay (fallback nếu chưa đủ)
  if (out.length < count) {
    try {
      const key = getSetting('pixabay_api_key');
      if (key) {
        const r = await axios.get(
          `https://pixabay.com/api/?key=${key}&q=${term}&image_type=photo&orientation=horizontal&per_page=${Math.min(count + 4, 15)}&safesearch=true`,
          { timeout: 15_000 });
        for (const h of (r.data?.hits || [])) {
          const u = h?.largeImageURL || h?.webformatURL;
          if (u && !out.includes(u)) out.push(u);
          if (out.length >= count) break;
        }
      }
    } catch (e: any) { console.warn('[stock] pixabay fail:', e?.response?.status || e?.message); }
  }
  return out.slice(0, count);
}

/** Gemini Vision tag 1 ảnh — cache vào footage_vision_tags. */
export async function tagFootageImage(footageId: number): Promise<VisionTag | null> {
  // Cache hit?
  const cached = db.prepare(`SELECT * FROM footage_vision_tags WHERE footage_id = ?`).get(footageId) as any;
  if (cached) {
    return {
      scene: cached.scene || 'other',
      subjects: (() => { try { return JSON.parse(cached.subjects_json || '[]'); } catch { return []; } })(),
      mood: cached.mood || '',
      location_hint: cached.location_hint || '',
    };
  }

  const fr = db.prepare(`SELECT id, path FROM v5_footage WHERE id = ?`).get(footageId) as any;
  if (!fr || !fr.path) return null;
  const localPath = resolveLocalPath(fr.path);
  if (!fs.existsSync(localPath)) {
    console.warn(`[article-images] file missing: ${localPath}`);
    return null;
  }

  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.warn('[article-images] google_api_key missing'); return null; }

  try {
    const base64 = fs.readFileSync(localPath).toString('base64');
    const mime = localPath.toLowerCase().endsWith('.png') ? 'image/png'
               : localPath.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: VISION_PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' },
      },
      { timeout: 30_000 },
    );
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    // Robust parse: Gemini đôi khi prepend "Here is the..." dù set responseMimeType
    let p: any = null;
    try { p = JSON.parse(text); } catch {}
    if (!p) {
      const m = String(text).match(/\{[\s\S]*\}/);
      if (m) { try { p = JSON.parse(m[0]); } catch {} }
    }
    if (!p) {
      // Fallback an toàn — không crash, scene='other' (vẫn pick được ảnh)
      db.prepare(
        `INSERT OR REPLACE INTO footage_vision_tags (footage_id, scene, subjects_json, mood, location_hint, tagged_at, tagged_by)
         VALUES (?, 'other', '[]', '', '', ?, 'gemini-parse-fail')`,
      ).run(footageId, Date.now());
      return { scene: 'other', subjects: [], mood: '', location_hint: '' };
    }
    const tag: VisionTag = {
      scene: String(p.scene || 'other').toLowerCase(),
      subjects: Array.isArray(p.subjects) ? p.subjects.slice(0, 4).map(String) : [],
      mood: String(p.mood || '').toLowerCase(),
      location_hint: String(p.location_hint || '').toLowerCase(),
    };
    db.prepare(
      `INSERT OR REPLACE INTO footage_vision_tags (footage_id, scene, subjects_json, mood, location_hint, tagged_at, tagged_by)
       VALUES (?, ?, ?, ?, ?, ?, 'gemini-3.5-flash')`,
    ).run(footageId, tag.scene, JSON.stringify(tag.subjects), tag.mood, tag.location_hint, Date.now());
    return tag;
  } catch (e: any) {
    console.warn('[article-images] vision fail:', e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

/** Scene priority theo content pillar (ảnh đầu tiên = cover). */
function scenePreference(pillar: ContentPillar): string[] {
  switch (pillar) {
    case 'homestay': return ['bedroom', 'view', 'area', 'exterior', 'lobby'];
    case 'hotel': return ['lobby', 'bedroom', 'pool', 'exterior', 'view'];
    case 'apartment': return ['bedroom', 'area', 'view', 'exterior', 'other'];
    case 'destination': return ['view', 'area', 'exterior', 'food', 'other'];
    case 'tips': return ['area', 'view', 'exterior', 'other'];
    case 'insider': return ['area', 'food', 'view', 'exterior', 'other'];
    case 'partner': return ['exterior', 'lobby', 'bedroom', 'view', 'other'];
    default: return ['view', 'exterior', 'other'];
  }
}

/**
 * Chọn N ảnh cho bài: chưa dùng 60 ngày + scene match + qua copyright firewall.
 * Tag ảnh on-the-fly nếu chưa có vision tag.
 */
export async function pickImagesForArticle(opts: {
  pillar: ContentPillar;
  count: number;          // số ảnh cần (vd 4: 1 cover + 3 inline)
  preferLocationHint?: string; // 'beach' | 'mountain' | 'city' ... (best-effort)
  stockQuery?: string;    // từ khóa điểm đến → lấy ảnh stock free cho bài du lịch
}): Promise<Array<{ footage_id: number; public_url: string; scene: string; is_cover: boolean }>> {
  const want = Math.max(1, Math.min(opts.count, 8));

  // ── Bài ĐIỂM ĐẾN (destination/insider/tips): ưu tiên ảnh STOCK đúng cảnh nơi đó ──
  //    (own footage là ảnh KS HCM/Đà Lạt — không có cảnh Hà Giang/Phú Quốc...).
  if (['destination', 'insider', 'tips'].includes(opts.pillar) && opts.stockQuery) {
    try {
      const urls = await fetchStockImages(opts.stockQuery, want);
      if (urls.length >= 1) {
        console.log(`[article-images] dùng ${urls.length} ảnh STOCK free (Pexels/Pixabay) cho điểm đến: "${opts.stockQuery}"`);
        return urls.map((u, i) => ({ footage_id: 0, public_url: u, scene: 'destination', is_cover: i === 0 }));
      }
      console.warn('[article-images] stock rỗng → fallback ảnh own');
    } catch (e: any) { console.warn('[article-images] stock lỗi → fallback own:', e?.message); }
  }

  const cutoff = Date.now() - DEDUP_WINDOW_DAYS * 86400_000;

  // Candidate pool: ảnh image, KHÔNG dùng trong 60 ngày, KHÔNG blacklist
  const candidates = db.prepare(
    `SELECT vf.id, vf.path
     FROM v5_footage vf
     WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
       AND vf.path IS NOT NULL
       AND vf.id NOT IN (
         SELECT footage_id FROM seo_article_images WHERE used_at > ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM copyright_takedown_blacklist b
         WHERE b.image_path = vf.path
       )
     ORDER BY RANDOM()
     LIMIT 60`,
  ).all(cutoff) as Array<{ id: number; path: string }>;

  if (candidates.length === 0) {
    console.warn('[article-images] no fresh candidates — fallback ignoring 60d dedup');
    // Fallback: ignore dedup nếu cạn ảnh (vẫn tránh blacklist)
    const fallback = db.prepare(
      `SELECT vf.id, vf.path FROM v5_footage vf
       WHERE (vf.media_type='image' OR vf.media_type IS NULL) AND vf.path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM copyright_takedown_blacklist b WHERE b.image_path = vf.path)
       ORDER BY RANDOM() LIMIT 30`,
    ).all() as Array<{ id: number; path: string }>;
    candidates.push(...fallback);
  }

  const prefScenes = scenePreference(opts.pillar);
  const picked: Array<{ footage_id: number; public_url: string; scene: string; is_cover: boolean }> = [];
  const usedScenes = new Set<string>();

  // Tag + score candidates (tag tối đa 20 ảnh để tiết kiệm Gemini quota)
  let tagged = 0;
  const scored: Array<{ id: number; path: string; scene: string; score: number }> = [];
  for (const c of candidates) {
    if (picked.length >= want && scored.length >= want * 3) break;
    let tag: VisionTag | null = null;
    const cachedTag = db.prepare(`SELECT scene, location_hint FROM footage_vision_tags WHERE footage_id = ?`).get(c.id) as any;
    if (cachedTag) {
      tag = { scene: cachedTag.scene, subjects: [], mood: '', location_hint: cachedTag.location_hint || '' };
    } else if (tagged < 20) {
      tag = await tagFootageImage(c.id);
      tagged++;
    }
    const scene = tag?.scene || 'other';
    let score = 0;
    const sceneIdx = prefScenes.indexOf(scene);
    score += sceneIdx >= 0 ? (prefScenes.length - sceneIdx) * 10 : 1;
    if (opts.preferLocationHint && tag?.location_hint === opts.preferLocationHint) score += 15;
    scored.push({ id: c.id, path: c.path, scene, score });
  }

  // Sort by score desc, pick diverse scenes
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (picked.length >= want) break;
    // Prefer scene diversity (tránh 4 ảnh cùng 1 scene)
    if (picked.length > 0 && usedScenes.has(s.scene) && usedScenes.size < want && picked.length < want) {
      const hasUnused = scored.some(x => !usedScenes.has(x.scene) && !picked.find(p => p.footage_id === x.id));
      if (hasUnused) continue;
    }
    picked.push({
      footage_id: s.id,
      public_url: getPublicImageUrl(s.path),
      scene: s.scene,
      is_cover: picked.length === 0,
    });
    usedScenes.add(s.scene);
  }

  return picked.slice(0, want);
}

/** Record ảnh đã gán cho bài (để bài sau dedup). */
export function recordArticleImages(articleId: number, images: Array<{ footage_id: number; scene: string; public_url?: string }>): void {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO seo_article_images (article_id, footage_id, position, vision_tags, used_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((imgs: any[]) => {
    imgs.forEach((img, i) => {
      if (img.footage_id && img.footage_id > 0)   // chỉ dedup ảnh own; ảnh stock (footage_id=0) bỏ qua
        stmt.run(articleId, img.footage_id, i, JSON.stringify({ scene: img.scene }), now);
    });
  });
  tx(images);

  // Update cover_image_url + image_footage_ids on article
  const ids = images.map(i => i.footage_id).filter((id: number) => id > 0);
  const first = images[0];
  let cover: string | null = null;
  if (first) {
    if (first.footage_id && first.footage_id > 0)
      cover = getPublicImageUrl((db.prepare(`SELECT path FROM v5_footage WHERE id=?`).get(first.footage_id) as any)?.path || '');
    else cover = first.public_url || null;   // ảnh stock → dùng URL trực tiếp
  }
  db.prepare(
    `UPDATE seo_articles SET image_footage_ids = ?, cover_image_url = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(ids), cover, now, articleId);
}

/** Inject ảnh vào body_html của bài (sau intro + giữa các H2). */
export function injectImagesIntoHtml(bodyHtml: string, images: Array<{ public_url: string; scene: string }>, title: string): string {
  if (images.length === 0) return bodyHtml;

  // Cover ảnh đầu — chèn ngay đầu bài
  const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  let html = `<figure class="article-cover"><img src="${esc(images[0].public_url)}" alt="${esc(title)}" loading="eager" style="width:100%;border-radius:12px;margin-bottom:24px"/></figure>\n` + bodyHtml;

  // Inline ảnh còn lại — chèn trước mỗi H2 (bắt đầu từ H2 thứ 2)
  const inline = images.slice(1);
  if (inline.length > 0) {
    const h2parts = html.split(/(<h2[^>]*>)/);
    let imgIdx = 0;
    let out = '';
    let h2seen = 0;
    for (let i = 0; i < h2parts.length; i++) {
      if (h2parts[i].match(/^<h2/)) {
        h2seen++;
        if (h2seen >= 2 && imgIdx < inline.length) {
          out += `<figure class="article-inline"><img src="${esc(inline[imgIdx].public_url)}" alt="${esc(title + ' - ' + inline[imgIdx].scene)}" loading="lazy" style="width:100%;border-radius:10px;margin:20px 0"/></figure>\n`;
          imgIdx++;
        }
      }
      out += h2parts[i];
    }
    html = out;
  }
  return html;
}
