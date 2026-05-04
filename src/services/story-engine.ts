/**
 * Story Engine — Series storytelling 8 tập/tháng (T5 + T7).
 *
 * Flow:
 *   1. Đầu tháng (cron 28) hoặc manual: AI propose concept + generate 8 episodes
 *   2. Auto-schedule T5/T7 19:00 VN từ T7 đầu tháng
 *   3. Cron T5/T7 19:00-21:00 → publishEpisodeToAllPages → cross-post Sondervn blog
 *
 * Schema:
 *   story_series   — 1 series/tháng (month_slug "2026-05")
 *   story_episodes — 8 tập/series, status: draft|approved|publishing|published|failed
 */
import axios from 'axios';
import { db, getSetting } from '../db';
import { publishText, publishImage, mediaFullPath } from './facebook';
import { generateImagePrompt } from './claude';
import { generateImageSmart } from './imagegen';

// ═══ Direct Claude call (bypass router để tận dụng max_tokens 4096) ═══
async function callClaude(system: string, user: string, maxTokens = 4096): Promise<string> {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not in settings table');
  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 180_000,
      }
    );
    const text = (r.data?.content || []).map((b: any) => b?.text || '').join('');
    if (!text) throw new Error('empty response');
    return text;
  } catch (e: any) {
    const detail = e?.response?.data?.error?.message || e?.message || 'unknown';
    throw new Error(`Claude: ${detail}`);
  }
}

// ═══ schema migration (idempotent) ═══
db.exec(`
CREATE TABLE IF NOT EXISTS story_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  concept TEXT,
  bible_md TEXT,
  start_date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  episode_no INTEGER NOT NULL,
  beat TEXT,
  title TEXT,
  caption TEXT,
  scheduled_at INTEGER NOT NULL,
  published_at INTEGER,
  fb_post_ids TEXT,
  blog_slug TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT,
  UNIQUE (series_id, episode_no)
);
CREATE INDEX IF NOT EXISTS idx_story_episodes_sched ON story_episodes(status, scheduled_at);
`);

// ALTER (idempotent): add image columns if missing
try {
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('story_episodes')`).all() as any[]).map(r => r.name);
  if (!cols.includes('image_url')) db.exec(`ALTER TABLE story_episodes ADD COLUMN image_url TEXT`);
  if (!cols.includes('media_id')) db.exec(`ALTER TABLE story_episodes ADD COLUMN media_id INTEGER`);
  if (!cols.includes('image_prompt')) db.exec(`ALTER TABLE story_episodes ADD COLUMN image_prompt TEXT`);
} catch (e: any) { console.warn('[story-engine] ALTER skip:', e?.message); }

// ═══ schedule helpers ═══

const TZ_OFFSET_MS = 7 * 3600 * 1000;

/** Epoch ms for given VN local date+time. */
function vnDate(year: number, month: number, day: number, hour = 19, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 7, minute, 0);
}

/** 0=Sun .. 6=Sat in VN time */
function dayOfWeekVN(epochMs: number): number {
  return new Date(epochMs + TZ_OFFSET_MS).getUTCDay();
}

/** Build 8-date schedule starting from first T7 of month, alternating T5+T7 at 19:00 VN. */
export function buildSchedule(year: number, month: number): number[] {
  const dates: number[] = [];
  // Find first Saturday
  let firstSat = 0;
  for (let day = 1; day <= 7; day++) {
    const candidate = vnDate(year, month, day, 19, 0);
    if (dayOfWeekVN(candidate) === 6) {
      firstSat = candidate;
      break;
    }
  }
  if (!firstSat) throw new Error(`buildSchedule: no Saturday in ${year}-${month}`);

  dates.push(firstSat);
  let cur = firstSat;
  while (dates.length < 8) {
    cur += 24 * 3600 * 1000;
    const dow = dayOfWeekVN(cur);
    if (dow === 4 || dow === 6) dates.push(cur);
  }
  return dates;
}

// ═══ AI generation ═══

const SERIES_SYSTEM = `Bạn là cây bút storytelling Việt Nam. Viết 8 tập caption Facebook cho series storytelling thương hiệu lưu trú Sonder.

VOICE BẮT BUỘC:
- POV ngôi thứ 1 "mình".
- Tiếng Việt ĐỜI THƯỜNG, thuần Việt. Người lao động, sinh viên đọc cũng cảm được.
- TRÁNH các từ: "tự sự", "ấp ủ", "trăn trở", "viên mãn", "đáng nhớ", "trải nghiệm khó quên", "đỉnh cao", "không thể bỏ qua", "hành trình", "khám phá bản thân".
- Câu ngắn-vừa, không câu phức 3 mệnh đề.
- Tối đa 3 emoji/tập, 1-2 hashtag cuối.
- Sonder = backdrop, KHÔNG hard-sell, KHÔNG "Liên hệ ngay/Book ngay".
- Cảm xúc thật, không sến, không meme rỗng.

CẤU TRÚC 1 TẬP (700-900 chars KỂ CẢ hashtag):
1) HOOK 1-2 câu — mở scene cụ thể (giờ giấc, hành động, lời thoại)
2) BODY 3-5 câu — kể chi tiết: 5 giác quan, có nhân vật, có thoại nếu phù hợp
3) BEAT cảm xúc 1 câu — khoảnh khắc đáng để nhớ hoặc twist nhẹ
4) CTA mềm 1 câu — gợi ý nhẹ như bạn bè rủ rê
5) #hashtag 1 dòng cuối

QUY TẮC CONTINUITY:
- Tập 2 PHẢI nhắc 1 chi tiết tập 1 (ly nước ấm, anh Tuấn, phòng 305, etc.).
- Tập 5 nhắc lại Linh từ tập 4.
- Tập 8 closing line chính xác: "Đôi khi du lịch không phải đi đâu, mà là dừng lại đủ lâu — Sonder Airport vẫn đang ở đây 🏠"`;

function buildBatchUserPrompt(bible: string, batchNo: 1 | 2, prevEpisodes?: any[]): string {
  const start = batchNo === 1 ? 1 : 5;
  const end = batchNo === 1 ? 4 : 8;
  const prevContext = batchNo === 2 && prevEpisodes
    ? `\n\n# 4 TẬP ĐÃ VIẾT (chỉ để tham chiếu continuity, không cần lặp lại)\n${prevEpisodes.map((e: any) => `--- Tập ${e.episode_no}: ${e.title} ---\n${e.caption}`).join('\n\n')}\n`
    : '';

  return `Viết ${end - start + 1} tập caption Facebook (tập ${start}–${end}) bám sát story bible bên dưới. Không bịa nhân vật/bối cảnh ngoài bible.

# STORY BIBLE
${bible}
${prevContext}
# OUTPUT FORMAT (BẮT BUỘC ĐÚNG)
Dùng marker bên dưới, KHÔNG JSON, KHÔNG markdown fence:

[[EP ${start}]]
beat: <tên beat ngắn>
title: <tên tập>
caption:
<nội dung caption — viết tự nhiên, dùng dấu " ' xuống dòng emoji thoải mái>
[[EP ${start} END]]

[[EP ${start + 1}]]
beat: ...
title: ...
caption:
...
[[EP ${start + 1} END]]

...tiếp tục đến [[EP ${end}]] ... [[EP ${end} END]]

CHÚ Ý:
- ĐÚNG ${end - start + 1} khối tập ${start}–${end}, không thiếu marker.
- Mỗi caption 700-900 chars (đếm cả hashtag).
${batchNo === 2 ? '- Tập 5 PHẢI nhắc 1 chi tiết từ 4 tập đầu (callback continuity).\n- Tập 8 PHẢI kết thúc bằng closing line: "Đôi khi du lịch không phải đi đâu, mà là dừng lại đủ lâu — Sonder Airport vẫn đang ở đây 🏠" + 2 hashtag #SonderAirport #DừngLạiĐủLâu.' : '- Tập 1 mở đầu series, hook scene cụ thể.\n- Mỗi tập sau callback chi tiết tập trước.'}
- KHÔNG kèm giải thích trước/sau khối [[EP]].`;
}

/** Parse output từ batch (range startNo..endNo). */
function parseEpisodesRange(raw: string, startNo: number, endNo: number): any[] {
  const episodes: any[] = [];
  for (let i = startNo; i <= endNo; i++) {
    const startMarker = `[[EP ${i}]]`;
    const endMarker = `[[EP ${i} END]]`;
    const startIdx = raw.indexOf(startMarker);
    const endIdx = raw.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0) {
      throw new Error(`Missing marker for ep ${i} (start=${startIdx}, end=${endIdx})`);
    }
    const block = raw.substring(startIdx + startMarker.length, endIdx).trim();
    const beatMatch = block.match(/^\s*beat:\s*(.+?)\s*$/m);
    const titleMatch = block.match(/^\s*title:\s*(.+?)\s*$/m);
    const captionIdx = block.search(/^\s*caption:\s*$/m);
    if (captionIdx < 0) throw new Error(`Missing 'caption:' line in ep ${i}`);
    const afterCaptionLabel = block.indexOf('\n', captionIdx);
    const caption = block.substring(afterCaptionLabel + 1).trim();
    if (caption.length < 100) throw new Error(`ep ${i}: caption too short (${caption.length})`);
    episodes.push({
      episode_no: i,
      beat: beatMatch?.[1].trim() || '',
      title: titleMatch?.[1].trim() || '',
      caption,
    });
  }
  return episodes;
}

/** Generate 8 episodes for given month from bible. Returns {ok, series_id?}. */
export async function generateSeries(monthSlug: string, bibleMd: string, title: string): Promise<{ ok: boolean; series_id?: number; error?: string; episodes?: any[] }> {
  const m = monthSlug.match(/^(\d{4})-(\d{2})$/);
  if (!m) return { ok: false, error: 'invalid month_slug, expected YYYY-MM' };
  const year = parseInt(m[1]); const month = parseInt(m[2]);

  let schedule: number[];
  try { schedule = buildSchedule(year, month); }
  catch (e: any) { return { ok: false, error: e.message }; }

  console.log(`[story-engine] generating series ${monthSlug} — first ep at ${new Date(schedule[0]).toISOString()}`);

  // ─── BATCH 1: episodes 1–4 ───
  let raw1: string;
  try {
    raw1 = await callClaude(SERIES_SYSTEM, buildBatchUserPrompt(bibleMd, 1), 4096);
  } catch (e: any) { return { ok: false, error: 'AI batch1: ' + e.message }; }

  let batch1: any[];
  try { batch1 = parseEpisodesRange(raw1, 1, 4); }
  catch (e: any) {
    console.error('[story-engine] batch1 parse fail. raw[:800]:', raw1.slice(0, 800));
    return { ok: false, error: 'parse batch1: ' + e.message };
  }
  console.log(`[story-engine] ✓ batch1: ${batch1.length} eps, lengths: ${batch1.map(e => e.caption.length).join('/')}`);

  // ─── BATCH 2: episodes 5–8 (with batch1 as continuity context) ───
  let raw2: string;
  try {
    raw2 = await callClaude(SERIES_SYSTEM, buildBatchUserPrompt(bibleMd, 2, batch1), 4096);
  } catch (e: any) { return { ok: false, error: 'AI batch2: ' + e.message }; }

  let batch2: any[];
  try { batch2 = parseEpisodesRange(raw2, 5, 8); }
  catch (e: any) {
    console.error('[story-engine] batch2 parse fail. raw[:800]:', raw2.slice(0, 800));
    return { ok: false, error: 'parse batch2: ' + e.message };
  }
  console.log(`[story-engine] ✓ batch2: ${batch2.length} eps, lengths: ${batch2.map(e => e.caption.length).join('/')}`);

  const episodes = [...batch1, ...batch2];
  if (episodes.length !== 8) return { ok: false, error: `total ${episodes.length} eps, expected 8` };

  // Insert (upsert) series
  const now = Date.now();
  db.prepare(`
    INSERT INTO story_series (month_slug, title, bible_md, start_date, status, created_at)
    VALUES (?, ?, ?, ?, 'approved', ?)
    ON CONFLICT(month_slug) DO UPDATE SET title=excluded.title, bible_md=excluded.bible_md, start_date=excluded.start_date, status='approved'
  `).run(monthSlug, title, bibleMd, schedule[0], now);

  const seriesRow = db.prepare(`SELECT id FROM story_series WHERE month_slug = ?`).get(monthSlug) as any;
  const seriesId = seriesRow.id as number;

  // Wipe + insert episodes
  db.prepare(`DELETE FROM story_episodes WHERE series_id = ?`).run(seriesId);
  const epIns = db.prepare(
    `INSERT INTO story_episodes (series_id, episode_no, beat, title, caption, scheduled_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'approved')`
  );
  const txn = db.transaction(() => {
    for (let i = 0; i < 8; i++) {
      const ep = episodes[i];
      epIns.run(
        seriesId,
        ep.episode_no || (i + 1),
        ep.beat || '',
        ep.title || '',
        String(ep.caption).trim(),
        schedule[i]
      );
    }
  });
  txn();

  console.log(`[story-engine] ✓ series #${seriesId} (${monthSlug}) — 8 ep saved + scheduled`);
  return { ok: true, series_id: seriesId, episodes };
}

// ═══ publish runner ═══

interface Page { id: number; fb_page_id: string; access_token: string; name: string; hotel_id: number; }

export async function publishEpisodeToAllPages(episodeId: number): Promise<{ ok: boolean; published_pages: number; failed: number; fb_post_ids: string[]; error?: string }> {
  const ep = db.prepare(
    `SELECT id, series_id, episode_no, title, caption, status, fb_post_ids, image_url FROM story_episodes WHERE id = ?`
  ).get(episodeId) as any;
  if (!ep) return { ok: false, published_pages: 0, failed: 0, fb_post_ids: [], error: 'episode not found' };
  if (ep.status === 'published') {
    return { ok: true, published_pages: 0, failed: 0, fb_post_ids: JSON.parse(ep.fb_post_ids || '[]') };
  }

  const pages = db.prepare(`SELECT id, fb_page_id, access_token, name, hotel_id FROM pages`).all() as Page[];
  if (pages.length === 0) {
    return { ok: false, published_pages: 0, failed: 0, fb_post_ids: [], error: 'no pages' };
  }

  db.prepare(`UPDATE story_episodes SET status='publishing' WHERE id = ?`).run(episodeId);

  const fbIds: string[] = [];
  let failed = 0; let lastErr = '';
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      let r: any;
      if (ep.image_url) {
        // Resolve image path: HTTPS URL → pass directly; "/media/xxx.jpg" → resolve to disk path
        const imgPath = /^https?:\/\//i.test(ep.image_url)
          ? ep.image_url
          : (ep.image_url.startsWith('/media/') ? mediaFullPath(ep.image_url.replace('/media/', '')) : ep.image_url);
        r = await publishImage(p.fb_page_id, p.access_token, ep.caption, imgPath);
        console.log(`[story-engine] ep#${episodeId} → page ${p.name}: ${r.fbPostId} (with image)`);
      } else {
        r = await publishText(p.fb_page_id, p.access_token, ep.caption);
        console.log(`[story-engine] ep#${episodeId} → page ${p.name}: ${r.fbPostId} (text only)`);
      }
      fbIds.push(`${p.id}:${r.fbPostId}`);
    } catch (e: any) {
      failed++;
      lastErr = e?.response?.data?.error?.message || e?.message || 'unknown';
      console.warn(`[story-engine] ep#${episodeId} → page ${p.name}: FAIL ${lastErr}`);
    }
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 30_000));
  }

  const status = fbIds.length > 0 ? 'published' : 'failed';
  db.prepare(
    `UPDATE story_episodes SET status=?, published_at=?, fb_post_ids=?, error=? WHERE id = ?`
  ).run(status, Date.now(), JSON.stringify(fbIds), failed > 0 ? lastErr.slice(0, 500) : null, episodeId);

  // ─── Cross-post Instagram + Zalo (non-blocking) ───
  // Sử dụng FB CDN URL của post vừa publish (most reliable cho IG/Zalo fetch)
  if (fbIds.length > 0) {
    try {
      const firstEntry = fbIds[0];
      const [pageIdStr, fbPostId] = firstEntry.split(':');
      const page = pages.find((p: Page) => String(p.id) === pageIdStr);

      // Try fetch FB CDN image URL (post sau publish có full_picture từ FB CDN)
      let imageUrl: string | undefined;
      if (page && ep.image_url) {
        try {
          const r = await axios.get(`https://graph.facebook.com/v18.0/${fbPostId}`, {
            params: { fields: 'full_picture', access_token: page.access_token },
            timeout: 15_000,
          });
          imageUrl = r.data?.full_picture;
          if (imageUrl) console.log(`[story-engine] FB CDN image: ${imageUrl.slice(0, 70)}...`);
        } catch (e: any) {
          console.warn('[story-engine] fetch FB CDN fail:', e?.message);
        }
        // Fallback: mkt.sondervn.com public URL
        if (!imageUrl) {
          imageUrl = ep.image_url.startsWith('/media/')
            ? `https://mkt.sondervn.com${ep.image_url}`
            : ep.image_url;
        }
      }

      // Story chỉ cross-post Instagram, KHÔNG đăng Zalo (preserve quota Zalo OA Free 15/cycle cho mục đích khác)
      try {
        const { publishToHotel, getIgAccountsForHotel } = require('./instagram-publisher');
        const igAccounts = getIgAccountsForHotel(page?.hotel_id || 1);
        if (!imageUrl) {
          console.log(`[story-engine] ep#${episodeId} skip IG: no image url`);
        } else if (!igAccounts || igAccounts.length === 0) {
          console.log(`[story-engine] ep#${episodeId} skip IG: no IG accounts for hotel ${page?.hotel_id}`);
        } else {
          publishToHotel(page?.hotel_id || 1, imageUrl, ep.caption)
            .then((results: any[]) => {
              const ok = results.filter((r: any) => r.success).length;
              console.log(`[story-engine] ep#${episodeId} → IG: ${ok}/${results.length} (Zalo SKIPPED for story flow)`);
              // Log to cross_post_log for tracking
              try {
                for (const r of results) {
                  db.prepare(
                    `INSERT OR IGNORE INTO cross_post_log (fb_post_id, hotel_id, platform, target_id, result, external_id, error, created_at)
                     VALUES (?, ?, 'instagram', ?, ?, ?, ?, ?)`
                  ).run(fbPostId, page?.hotel_id || 1, String(r.account_id || ''), r.success ? 'success' : 'failed', r.media_id || null, r.error || null, Date.now());
                }
              } catch (e: any) { console.warn(`[story-engine] log_xpost: ${e?.message}`); }
            })
            .catch((e: any) => console.warn(`[story-engine] IG cross-post err: ${e?.message}`));
        }
      } catch (e: any) {
        console.warn(`[story-engine] IG cross-post require fail: ${e?.message}`);
      }
    } catch (e: any) { console.warn(`[story-engine] cross-post setup err: ${e?.message}`); }
  }

  // ─── Cross-post Sondervn blog (non-blocking) ───
  if (fbIds.length > 0) {
    try {
      const series = db.prepare(`SELECT month_slug, title FROM story_series WHERE id = ?`).get(ep.series_id) as any;
      const slug = `series-${series.month_slug}-ep${ep.episode_no}`;
      const { pushBlogPost, isEnabled } = require('./sonder-blog-bridge');
      if (isEnabled()) {
        // Resolve public image URL for blog coverImage
        let coverImg: string | null = null;
        if (ep.image_url) {
          coverImg = ep.image_url.startsWith('/media/')
            ? `https://mkt.sondervn.com${ep.image_url}`
            : ep.image_url;
        }
        pushBlogPost({
          slug,
          title: `${series.title} — Tập ${ep.episode_no}: ${ep.title || ''}`.trim(),
          excerpt: ep.caption.slice(0, 200) + '...',
          content: ep.caption,
          coverImage: coverImg,
          category: 'cau-chuyen-du-lich',
          tags: ['series', 'storytelling', series.month_slug],
          author: 'Sonder Storyteller',
          status: 'published',
          publishedAt: new Date().toISOString(),
        }, { idempotencyKey: `story-${slug}` })
        .then((r: any) => {
          if (r.ok) {
            db.prepare(`UPDATE story_episodes SET blog_slug=? WHERE id=?`).run(slug, episodeId);
            console.log(`[story-engine] ep#${episodeId} → blog ${slug}: ${r.action}`);
          } else console.warn(`[story-engine] blog ep#${episodeId}: ${r.error}`);
        })
        .catch((e: any) => console.warn(`[story-engine] blog dispatch err: ${e?.message}`));
      }
    } catch (e: any) { console.warn(`[story-engine] cross-post skip: ${e?.message}`); }
  }

  return { ok: fbIds.length > 0, published_pages: fbIds.length, failed, fb_post_ids: fbIds };
}

// ═══ scheduler tick ═══

export async function runDueStoryEpisodes(): Promise<{ found: number; published: number; failed: number }> {
  const now = Date.now();
  // catch-up window: 6h after scheduled time (in case pm2 restart misses cron)
  const due = db.prepare(
    `SELECT id, episode_no, scheduled_at FROM story_episodes
     WHERE status = 'approved' AND scheduled_at <= ? AND scheduled_at > ?
     ORDER BY scheduled_at ASC LIMIT 3`
  ).all(now, now - 6 * 3600 * 1000) as any[];

  if (due.length === 0) return { found: 0, published: 0, failed: 0 };

  console.log(`[story-engine] ${due.length} episode(s) due`);
  let pub = 0, fl = 0;
  for (const ep of due) {
    const r = await publishEpisodeToAllPages(ep.id);
    if (r.ok) pub++; else fl++;
  }
  return { found: due.length, published: pub, failed: fl };
}

// ═══ AI propose next month concept ═══

const CONCEPT_SYSTEM = `Bạn đề xuất concept story-series Facebook 8 tập cho thương hiệu lưu trú Sonder Việt Nam.

Yêu cầu:
- Gắn mùa/lễ Việt Nam.
- 1 nhân vật chính rõ ràng + 1 nhân vật phụ ở Sonder (kiểu lễ tân/chủ nhà).
- Cảm xúc gần gũi: trốn việc, du lịch chữa lành, đoàn tụ, reset, tìm lại bạn cũ.
- Voice đời thường, người lao động cảm được.

Trả về DUY NHẤT 1 JSON object (không markdown fence):
{
  "title": "Tên series ngắn",
  "subtitle": "1 câu mô tả",
  "city": "Sài Gòn|Đà Lạt|Hội An|Đà Nẵng|Phú Quốc",
  "main_character": "Mô tả nhân vật chính",
  "supporting_character": "Mô tả nhân vật phụ ở Sonder",
  "tone": "1 câu mô tả tone (vui/trầm/ấm áp/...)",
  "8_beats": ["Beat tập 1", "Beat tập 2", "...", "Beat tập 8"]
}`;

function getSeasonHint(month: number): string {
  if ([3, 4, 5].includes(month)) return 'cuối xuân/đầu hè, nắng nhẹ, mưa rào bất chợt';
  if ([6, 7, 8].includes(month)) return 'hè cao điểm, nắng to, mưa lớn, mùa du lịch family';
  if ([9, 10, 11].includes(month)) return 'thu, lễ Vu Lan, Trung Thu, Quốc Khánh, mưa nhẹ, mát mẻ';
  if ([12, 1].includes(month)) return 'cuối năm, Noel, đông, lạnh nhẹ, đoàn tụ, Tết tới gần';
  if (month === 2) return 'Tết Nguyên Đán, du xuân, khách trở lại';
  return 'tháng giao mùa';
}

export async function proposeNextConcept(monthSlug: string): Promise<any> {
  const m = monthSlug.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error('invalid month_slug');
  const year = parseInt(m[1]); const month = parseInt(m[2]);
  const monthNames = ['', 'Một','Hai','Ba','Tư','Năm','Sáu','Bảy','Tám','Chín','Mười','Mười Một','Mười Hai'];

  // Look up past series to avoid repeating
  const pastTitles = db.prepare(`SELECT title, month_slug FROM story_series ORDER BY id DESC LIMIT 12`).all() as any[];
  const pastList = pastTitles.map((p: any) => `${p.month_slug}: ${p.title}`).join(', ') || '(chưa có)';

  const user = `Đề xuất concept story-series 8 tập cho tháng ${monthNames[month]} năm ${year}.

Cities Sonder: Sài Gòn (Tân Bình - đã ra mắt), Đà Lạt, Hội An, Đà Nẵng, Phú Quốc.
Mùa tháng ${month}: ${getSeasonHint(month)}.
Series đã làm: ${pastList}.

KHÔNG lặp city + tone của series gần nhất. Mỗi tháng nên đổi không gian + cảm xúc.

Trả về JSON object đúng schema.`;

  const raw = await callClaude(CONCEPT_SYSTEM, user, 1500);
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

function buildBibleFromConcept(c: any, monthSlug: string): string {
  const beatLines = (c['8_beats'] || []).map((b: string, i: number) => `${i + 1}. **Tập ${i + 1}** — ${b}`).join('\n');
  return `# ${c.title}

## Concept
${c.subtitle}
City: ${c.city}
Tone: ${c.tone}
Tháng: ${monthSlug}

## Nhân vật
- **Mình (POV ngôi 1)**: ${c.main_character}
- **${c.supporting_character.split(' ').slice(0, 2).join(' ')}**: ${c.supporting_character}

## Bối cảnh
Sonder ${c.city}.

## 8 Tập (Beat structure 4-Act, mỗi Act 2 tập)
${beatLines}

## Voice rules
- POV ngôi thứ 1 "mình"
- Tiếng Việt đời thường, từ thuần Việt
- 700-900 chars/tập (kèm hashtag)
- Tối đa 3 emoji/tập, 1-2 hashtag
- Tập sau callback chi tiết tập trước
- Sonder = backdrop, KHÔNG hard-sell

## Closing tập 8
Phải có 1 câu đóng cảm xúc nhẹ nhàng + 2 hashtag (1 brand + 1 theme).
`;
}

// ═══ image generation per episode ═══

/** Hard-coded scene anchors for tháng 5 series — đảm bảo style nhất quán + bám bối cảnh.
 *  Format: pre-made image prompt (English). Override bằng episode-specific override nếu có. */
const SCENE_PROMPTS_2026_05: Record<number, string> = {
  1: "Cinematic editorial photography, late-night Vietnamese boutique hotel lobby in Saigon Tan Binh, soft warm yellow lighting, a small wooden reception counter with a glass of warm water and a brass key, vintage tile floor, suitcase on the floor, no people faces, back-view silhouette of a woman in casual travel clothes, 11pm intimate atmosphere, film grain, shot on Sony A7, natural lighting, magazine quality, Vietnamese tropical interior",
  2: "Cinematic editorial photography, early morning sidewalk pho/bun-bo street stall in Saigon, 6am soft golden light, steaming bowl of beef noodle soup on small plastic table, motorbikes blurred in background, an elderly Vietnamese woman vendor's hands ladling broth, no faces visible, vintage Vietnamese street food vibe, warm tones, film grain, documentary photography",
  3: "Cinematic editorial photography, narrow Saigon residential alley afternoon, 3pm bright tropical light filtering through laundry lines, a small banh mi cart with paper-wrapped baguettes, dusty Tan Binh district streets, soft golden tones, no faces visible, atmospheric urban Vietnam documentary",
  4: "Cinematic editorial photography, hotel elevator lobby with heavy monsoon rain falling outside large windows, two grocery bags with fresh vegetables on the floor, wet floor reflections, twilight blue tones, intimate quiet moment, no faces visible, modern Vietnamese apartment interior, film grain",
  5: "Cinematic editorial photography, hotel balcony at evening overlooking Tan Son Nhat airport runway, two cans of green beer on a wooden small table, peanuts in a small bowl, runway lights blinking red and green in distance, plane taking off silhouette in sky, warm intimate twilight, no people faces, golden-hour to blue-hour transition, film grain",
  6: "Cinematic editorial photography, quiet Vietnamese hotel bedroom morning, glass cup of fresh ginger tea with floating ginger slices and honey on a wooden bedside table, soft sunlight through sheer curtains, white bedsheet rumpled, peaceful contemplative mood, intimate close-up still life, no people, film grain, magazine photography",
  7: "Cinematic editorial photography, dim Vietnamese hotel hallway 3am, soft yellow wall sconces, a small black suitcase pulled toward elevator, late night silent corridor with reflective tiled floor, atmospheric tension and quiet urgency, blue-grey shadows, no faces visible, film grain, cinematic noir mood",
  8: "Cinematic editorial photography, hotel bedroom afternoon homecoming, neatly folded white blanket on bed, a small handwritten paper note next to a glass of warm water on a wooden desk, soft golden afternoon light through balcony doors revealing distant airport runway, Vietnamese tropical interior, intimate peaceful homecoming mood, no people, film grain, May Saigon",
};

const COMMON_NEGATIVE = "text, watermark, logo, blurry, distorted face, extra fingers, low quality, cartoon, illustration, oversaturated, ai-generated look, plastic skin, fake";

export async function generateEpisodeImage(seriesId: number, episodeNo: number, opts: { force?: boolean } = {}): Promise<{ ok: boolean; image_url?: string; media_id?: number; error?: string }> {
  const ep = db.prepare(`SELECT id, caption, image_url, media_id FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(seriesId, episodeNo) as any;
  if (!ep) return { ok: false, error: `episode ${episodeNo} not found` };
  if (ep.image_url && !opts.force) {
    return { ok: true, image_url: ep.image_url, media_id: ep.media_id };
  }

  // Build prompt: prefer hard-coded scene anchor; else use Claude generateImagePrompt from caption first 3 lines
  let prompt = SCENE_PROMPTS_2026_05[episodeNo];
  if (!prompt) {
    const captionStart = ep.caption.split('\n').slice(0, 4).join('\n');
    prompt = await generateImagePrompt(captionStart);
  }
  const fullPrompt = `${prompt} | negative: ${COMMON_NEGATIVE}`;

  console.log(`[story-engine] gen image for ep ${episodeNo}: ${prompt.slice(0, 80)}...`);
  let r: any;
  try {
    r = await generateImageSmart(fullPrompt);
  } catch (e: any) {
    return { ok: false, error: 'imagegen: ' + e.message };
  }

  // Resolve filename → URL or local path
  const mediaRow = db.prepare(`SELECT filename, source FROM media WHERE id = ?`).get(r.mediaId) as any;
  if (!mediaRow) return { ok: false, error: 'media row missing after gen' };
  const isUrl = /^https?:\/\//i.test(mediaRow.filename);
  const imagePath = isUrl ? mediaRow.filename : ('/media/' + mediaRow.filename);

  db.prepare(`UPDATE story_episodes SET media_id=?, image_url=?, image_prompt=? WHERE id=?`)
    .run(r.mediaId, imagePath, prompt, ep.id);
  console.log(`[story-engine] ✓ ep ${episodeNo} image saved: media_id=${r.mediaId}, provider=${r.provider}`);
  return { ok: true, image_url: imagePath, media_id: r.mediaId };
}

export async function generateAllImagesForSeries(seriesId: number, opts: { force?: boolean } = {}): Promise<any> {
  const eps = db.prepare(`SELECT episode_no FROM story_episodes WHERE series_id = ? ORDER BY episode_no`).all(seriesId) as any[];
  const results: any[] = [];
  for (const ep of eps) {
    const r = await generateEpisodeImage(seriesId, ep.episode_no, opts);
    results.push({ episode_no: ep.episode_no, ...r });
  }
  return { results, ok: results.every(r => r.ok), succeeded: results.filter(r => r.ok).length };
}

// ═══ regenerate single episode (longer, deeper) ═══

export async function regenerateEpisode(
  seriesId: number,
  episodeNo: number,
  opts: { minChars?: number; maxChars?: number; extraInstruction?: string } = {}
): Promise<{ ok: boolean; episode?: any; error?: string }> {
  const minC = opts.minChars || 700;
  const maxC = opts.maxChars || 900;

  const series = db.prepare(`SELECT * FROM story_series WHERE id = ?`).get(seriesId) as any;
  if (!series) return { ok: false, error: 'series not found' };

  const targetEp = db.prepare(`SELECT * FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(seriesId, episodeNo) as any;
  if (!targetEp) return { ok: false, error: `episode ${episodeNo} not found` };

  const prevEp = episodeNo > 1 ? db.prepare(`SELECT episode_no, title, caption FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(seriesId, episodeNo - 1) as any : null;
  const nextEp = episodeNo < 8 ? db.prepare(`SELECT episode_no, title, caption FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(seriesId, episodeNo + 1) as any : null;

  const user = `Viết LẠI tập ${episodeNo} của series — DÀI HƠN, có CHIỀU SÂU hơn.

# STORY BIBLE
${series.bible_md}

# TẬP TRƯỚC (Tập ${prevEp?.episode_no}: ${prevEp?.title || ''})
${prevEp?.caption || '(không có)'}

# TẬP SAU (Tập ${nextEp?.episode_no}: ${nextEp?.title || ''}) — chỉ tham chiếu, KHÔNG sửa tập sau
${(nextEp?.caption || '').slice(0, 250)}${nextEp ? '...' : ''}

# YÊU CẦU TẬP ${episodeNo}: ${targetEp.title}
- ĐỘ DÀI: ${minC}-${maxC} chars (KỂ CẢ hashtag) — BẮT BUỘC dài hơn ${minC} chars để có chiều sâu
- FB sẽ cắt "Xem thêm" tự động — anh user OK chuyện đó, ưu tiên CHIỀU SÂU CÂU CHUYỆN.
- Continuity: PHẢI nhắc ÍT NHẤT 1 chi tiết cụ thể từ tập trước (callback rõ ràng)
- Cấu trúc đề xuất:
  1) Hook scene cụ thể — giờ giấc, hành động, môi trường (1-2 câu)
  2) Mô tả không gian/cảnh — 5 giác quan, có nhân vật, có thoại (3-4 câu)
  3) Tương tác/diễn biến chính (3-4 câu)
  4) Đoạn observation/suy ngẫm — về cảm xúc, sự khác biệt, điều mình mới thấy (2-3 câu — đây là nơi tạo CHIỀU SÂU)
  5) Beat cảm xúc nhỏ / twist nhẹ (1-2 câu)
  6) CTA mềm 1 câu
  7) #hashtag 1 dòng cuối
${opts.extraInstruction ? '- LƯU Ý THÊM: ' + opts.extraInstruction : ''}
- KHÔNG sến, KHÔNG triết lý suông — chiều sâu qua chi tiết cụ thể.
- Voice ĐỜI THƯỜNG. Tránh "tự sự", "trải nghiệm khó quên", "hành trình".

# OUTPUT FORMAT (CHÍNH XÁC)
[[EP ${episodeNo}]]
beat: ${targetEp.beat || ''}
title: ${targetEp.title || ''}
caption:
<caption tập ${episodeNo} dài ${minC}-${maxC} chars — viết tự nhiên, dùng " ' xuống dòng emoji thoải mái>
[[EP ${episodeNo} END]]

KHÔNG kèm giải thích trước/sau khối.`;

  console.log(`[story-engine] regenerating ep ${episodeNo} of series #${seriesId} (target ${minC}-${maxC} chars)`);
  const raw = await callClaude(SERIES_SYSTEM, user, 4096);

  let parsed: any[];
  try { parsed = parseEpisodesRange(raw, episodeNo, episodeNo); }
  catch (e: any) {
    console.error('[story-engine] regen parse fail. raw[:600]:', raw.slice(0, 600));
    return { ok: false, error: 'parse: ' + e.message };
  }

  const newEp = parsed[0];
  if (newEp.caption.length < minC) {
    console.warn(`[story-engine] regen too short: ${newEp.caption.length} < ${minC}, returning anyway`);
  }

  db.prepare(`UPDATE story_episodes SET caption = ?, beat = ?, title = ? WHERE series_id = ? AND episode_no = ?`)
    .run(newEp.caption, newEp.beat || targetEp.beat, newEp.title || targetEp.title, seriesId, episodeNo);

  console.log(`[story-engine] ✓ ep ${episodeNo} regenerated, length: ${newEp.caption.length}`);
  return { ok: true, episode: { ...newEp, length: newEp.caption.length } };
}

/** Cron entry: build & schedule next month's series. */
export async function buildAndScheduleMonth(monthSlug: string): Promise<any> {
  const exists = db.prepare(`SELECT id FROM story_series WHERE month_slug = ?`).get(monthSlug);
  if (exists) {
    console.log(`[story-engine] ${monthSlug} already exists, skip`);
    return { ok: false, error: 'already exists' };
  }

  console.log(`[story-engine] proposing concept for ${monthSlug}...`);
  const concept = await proposeNextConcept(monthSlug);
  console.log(`[story-engine] concept: ${concept.title} (${concept.city}, ${concept.tone})`);

  const bible = buildBibleFromConcept(concept, monthSlug);
  return generateSeries(monthSlug, bible, concept.title);
}
