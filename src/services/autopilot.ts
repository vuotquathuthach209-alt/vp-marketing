import { db, getSetting, setSetting } from '../db';
import { generate } from './router';
import { buildContext } from './wiki';
import { generateCaption, generateImagePrompt } from './claude';
import { generateImageSmart } from './imagegen';
import { config } from '../config';
import { getCachedRoomTypes } from './ota-sync';
import { getRandomDriveImage, syncDriveFolder } from './gdrive';
import { getNewsForContent } from './news-scraper';
import { getHotelPhoto } from './unsplash';

/**
 * Autopilot v2 — Content Calendar Engine
 *
 * WEEKLY STRATEGY (7 ngay):
 *   Thu 2: Hotel Photo (GDrive) — Product Showcase
 *   Thu 3: AI News + Brand — Brand Authority
 *   Thu 4: Web Inspiration — Tips & Inspiration
 *   Thu 5: Hotel Photo (GDrive) — Behind The Scenes
 *   Thu 6: AI News + Brand — Trend Jacking
 *   Thu 7: AI Gen + Lifestyle — Lifestyle & Food
 *   CN:    Hotel Photo + UGC — Community Stories
 *
 * HOOK ENGINE: Cau dau tien hut nguoi doc
 *   - question: Cau hoi gay to mo
 *   - fomo: So hai bo lo
 *   - story: Ke chuyen
 *   - stats: So lieu shock
 *   - tips: Bi mat / meo
 *   - controversial: Tranh cai nhe
 */

/* ═══════════════════════════════════════════
   CONTENT CALENDAR — Default 7-day strategy
   ═══════════════════════════════════════════ */

interface CalendarDay {
  day_of_week: number;
  content_type: string;
  image_source: string;  // gdrive | web | ai | unsplash
  pillar_name: string;
  pillar_emoji: string;
  pillar_desc: string;
  hook_style: string;
}

const DEFAULT_CALENDAR: CalendarDay[] = [
  { day_of_week: 0, content_type: 'community',       image_source: 'gdrive',  pillar_name: 'Community',  pillar_emoji: '❤️', pillar_desc: 'Review khach hang, cau chuyen khach o, UGC',          hook_style: 'story' },
  { day_of_week: 1, content_type: 'product',          image_source: 'gdrive',  pillar_name: 'Product',    pillar_emoji: '🏨', pillar_desc: 'Gioi thieu phong, tien ich, diem noi bat khach san', hook_style: 'question' },
  { day_of_week: 2, content_type: 'news_brand',       image_source: 'ai',      pillar_name: 'Authority',  pillar_emoji: '📰', pillar_desc: 'Tin du lich trending + thuong hieu Sonder',          hook_style: 'stats' },
  { day_of_week: 3, content_type: 'tips',             image_source: 'ai',      pillar_name: 'Tips',       pillar_emoji: '🎯', pillar_desc: 'Meo du lich, huong dan, cam nang',                  hook_style: 'tips' },
  { day_of_week: 4, content_type: 'behind_scenes',    image_source: 'gdrive',  pillar_name: 'Backstage',  pillar_emoji: '📸', pillar_desc: 'Hau truong, nhan vien, chuan bi phong',             hook_style: 'story' },
  { day_of_week: 5, content_type: 'news_brand',       image_source: 'ai',      pillar_name: 'Trending',   pillar_emoji: '🔥', pillar_desc: 'Bat trend, su kien hot + gan thuong hieu',           hook_style: 'controversial' },
  { day_of_week: 6, content_type: 'lifestyle',        image_source: 'ai',      pillar_name: 'Lifestyle',  pillar_emoji: '🎉', pillar_desc: 'Am thuc, trai nghiem dia phuong, cuoi tuan',        hook_style: 'fomo' },
];

/* ── Backward-compat pillar names ── */
const LEGACY_PILLARS = [
  { day: 'Chu Nhat', emoji: '❤️', name: 'Community', description: 'Cong dong, cau chuyen khach hang, UGC, review' },
  { day: 'Thu Hai',  emoji: '🏨', name: 'Product',   description: 'Gioi thieu phong, dich vu, tien ich khach san' },
  { day: 'Thu Ba',   emoji: '📰', name: 'Authority', description: 'Tin du lich trending + thuong hieu' },
  { day: 'Thu Tu',   emoji: '🎯', name: 'Tips',      description: 'Meo du lich, travel tips, huong dan' },
  { day: 'Thu Nam',  emoji: '📸', name: 'Backstage', description: 'Hau truong, behind the scenes, chuyen bi phong' },
  { day: 'Thu Sau',  emoji: '🔥', name: 'Trending',  description: 'Bat trend, su kien hot, flash sale' },
  { day: 'Thu Bay',  emoji: '🎉', name: 'Lifestyle', description: 'Lifestyle, am thuc, trai nghiem dia phuong' },
];

/* ═══════════════════════════════════════════
   HOOK ENGINE — Cau dau tien hut nguoi doc
   ═══════════════════════════════════════════ */

const HOOK_TEMPLATES: Record<string, string[]> = {
  question: [
    'Ban co biet tai sao {topic}?',
    '{topic} — ban da thu chua?',
    'Bao nhieu nguoi biet rang {topic}?',
    'Tai sao lai {topic}? Cau tra loi se khien ban bat ngo...',
    'Ban nghi {topic} la dung hay sai?',
  ],
  fomo: [
    'Chi con {number} phong cho cuoi tuan nay...',
    'Uu dai nay chi keo dai {number} ngay — dung bo lo!',
    '{number} khach da dat phong trong 48h qua — day la ly do...',
    'Cuoi tuan nay se het phong neu ban khong...',
    'Flash deal: {topic} — chi ap dung hom nay!',
  ],
  story: [
    'Hom qua, mot vi khach da {topic}. Va day la chuyen da xay ra...',
    'Cau chuyen cua anh Minh — nguoi khach dac biet nhat thang nay...',
    'Luc 5h sang, doi ngu cua chung minh da {topic}...',
    'Khong ai nghi rang {topic} — cho den khi...',
    'Mot ngay tai {hotel} bat dau nhu the nao? Hay de minh ke ban nghe...',
  ],
  stats: [
    '{number}% khach du lich mac sai lam nay khi chon khach san...',
    'So lieu moi: {topic} — ban nghi sao?',
    'Chi {number} phut de {topic} — ket qua se khien ban bat ngo!',
    'Theo khao sat: {number}% du khach Viet {topic}...',
    'Kinh nghiem tu {number} luot khach: {topic}',
  ],
  tips: [
    '{number} dieu nhan vien khach san khong bao gio noi cho ban...',
    'Meo nho giup ban {topic} — chi mat {number} giay!',
    'Bi kip du lich: {topic}',
    'Ban dang {topic} sai cach — day la cach dung!',
    'Checklist truoc khi {topic} — 99% nguoi quen buoc {number}!',
  ],
  controversial: [
    '{topic} — dung hay sai? Binh luan y kien cua ban!',
    'Nhieu nguoi nghi {topic}. Nhung su that la...',
    'Tranh luan nong: {topic} — ban chon ben nao?',
    'Pha bo dinh kien: {topic} khong phai nhu ban nghi!',
    'Tai sao {topic} dang thay doi toan bo nganh du lich?',
  ],
};

function generateHook(style: string, hotelName: string, topic: string): string {
  const templates = HOOK_TEMPLATES[style] || HOOK_TEMPLATES.question;
  const template = templates[Math.floor(Math.random() * templates.length)];
  const number = Math.floor(Math.random() * 90) + 10; // 10-99
  return template
    .replace(/\{topic\}/g, topic)
    .replace(/\{hotel\}/g, hotelName)
    .replace(/\{number\}/g, String(number));
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function getVNDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.tz }));
}

function getCalendarDay(hotelId: number, dow?: number): CalendarDay {
  const dayOfWeek = dow ?? getVNDate().getDay();

  // Try DB custom calendar first
  const custom = db.prepare(
    `SELECT * FROM content_calendar WHERE hotel_id = ? AND day_of_week = ? AND active = 1`
  ).get(hotelId, dayOfWeek) as CalendarDay | undefined;
  if (custom) return custom;

  // Default
  return DEFAULT_CALENDAR[dayOfWeek] || DEFAULT_CALENDAR[0];
}

export function getTodayPillar(hotelId: number = 1) {
  const cal = getCalendarDay(hotelId);
  return {
    emoji: cal.pillar_emoji,
    name: cal.pillar_name,
    description: cal.pillar_desc,
    content_type: cal.content_type,
    image_source: cal.image_source,
    hook_style: cal.hook_style,
  };
}

/** Get full week calendar */
export function getWeekCalendar(hotelId: number = 1): CalendarDay[] {
  return [0, 1, 2, 3, 4, 5, 6].map(dow => getCalendarDay(hotelId, dow));
}

function getHotelContext(hotelId: number): string {
  const hotel = db.prepare(`SELECT * FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return '';
  const parts: string[] = [`Khach san: ${hotel.name}`];
  if (hotel.ota_hotel_id) {
    const cache = db.prepare(`SELECT * FROM mkt_hotels_cache WHERE ota_hotel_id = ?`).get(hotel.ota_hotel_id) as any;
    if (cache) {
      if (cache.address) parts.push(`Dia chi: ${cache.address}`);
      if (cache.city) parts.push(`Thanh pho: ${cache.city}`);
      if (cache.star_rating) parts.push(`Hang sao: ${cache.star_rating}`);
    }
    const rooms = getCachedRoomTypes(hotel.ota_hotel_id) as any[];
    if (rooms.length > 0) {
      parts.push(`Loai phong:`);
      for (const r of rooms) {
        parts.push(`  - ${r.name}: ${Number(r.base_price).toLocaleString('vi-VN')}d/dem (con ${r.available_count}/${r.room_count})`);
      }
    }
  }
  return parts.join('\n');
}

/* ═══════════════════════════════════════════
   RESEARCH TOPICS — Enhanced with news + hooks
   ═══════════════════════════════════════════ */

export async function researchTopics(hotelId: number = 1): Promise<{
  pillar: string;
  topics: string[];
  reasoning: string;
  contentType: string;
  imageSource: string;
  hookStyle: string;
}> {
  const cal = getCalendarDay(hotelId);
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const brandCtx = await buildContext('brand voice', hotelId);
  const pillarCtx = await buildContext('content pillars', hotelId);
  const seasonCtx = await buildContext('seasonal calendar', hotelId);
  const hotelCtx = getHotelContext(hotelId);

  // Fetch news for news_brand content type
  let newsCtx = '';
  if (['news_brand'].includes(cal.content_type)) {
    const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    try {
      newsCtx = await getNewsForContent(hotel?.name || 'khach san');
    } catch (e: any) {
      console.warn('[autopilot] News fetch failed:', e.message);
    }
  }

  const wikiBlock = [brandCtx, pillarCtx, seasonCtx, hotelCtx, newsCtx].filter(Boolean).join('\n\n---\n\n');

  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Khach san';

  // Hook guidance in system prompt
  const hookGuide = `HOOK STYLE hom nay: "${cal.hook_style}" — Cau dau tien PHAI la kieu ${cal.hook_style}:
${(HOOK_TEMPLATES[cal.hook_style] || HOOK_TEMPLATES.question).slice(0, 3).map(t => `  Vi du: "${t}"`).join('\n')}`;

  const system = `Ban la Marketing Strategy Director cho ${hotelName} — chuyen gia content marketing nganh luu tru & du lich.
Nhiem vu: de xuat 2-3 chu de bai dang Facebook CU THE, hap dan cho hom nay.

LOAI NOI DUNG hom nay: ${cal.content_type}
${cal.content_type === 'product' || cal.content_type === 'behind_scenes' ? 'NGUON ANH: Anh thuc te cua khach san (tu Google Drive) — KHONG can mo ta anh' : ''}
${cal.content_type === 'news_brand' ? 'NGUON: Tin tuc trending + viet theo goc nhin thuong hieu khach san' : ''}

${hookGuide}

Yeu cau:
- Moi chu de phai du cu the de viet caption ngay (khong chung chung)
- Cau dau tien (HOOK) phai hut, gay to mo, khien nguoi ta dung lai doc
- Phu hop voi content pillar + loai noi dung hom nay
- Tan dung ngu canh mua vu, su kien neu co
- Tra loi theo dung format JSON ben duoi, KHONG markdown

Format tra ve (JSON thuan):
{"topics":["chu de 1","chu de 2","chu de 3"],"reasoning":"ly do chon ngan gon"}`;

  const user = `📅 Hom nay: ${dateStr}
📋 Pillar: ${cal.pillar_emoji} ${cal.pillar_name} — ${cal.pillar_desc}
📝 Content Type: ${cal.content_type} | Image: ${cal.image_source} | Hook: ${cal.hook_style}

--- KIEN THUC DOANH NGHIEP ---
${wikiBlock || '(Chua co du lieu wiki)'}
--- HET ---

Hay de xuat 2-3 chu de cu the cho bai dang hom nay.`;

  const raw = await generate({ task: 'caption', system, user });

  let topics: string[] = [];
  let reasoning = '';
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"topics"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      topics = parsed.topics || [];
      reasoning = parsed.reasoning || '';
    }
  } catch {
    topics = raw.split('\n').filter(l => l.trim().length > 10).slice(0, 3).map(l => l.replace(/^[\d.\-*]+\s*/, '').trim());
    reasoning = 'Parsed from free-text response';
  }

  if (topics.length === 0) {
    topics = [`${cal.pillar_name}: Gioi thieu trai nghiem tai ${hotelName}`];
    reasoning = 'Fallback';
  }

  return {
    pillar: `${cal.pillar_emoji} ${cal.pillar_name}`,
    topics,
    reasoning,
    contentType: cal.content_type,
    imageSource: cal.image_source,
    hookStyle: cal.hook_style,
  };
}

/* ═══════════════════════════════════════════
   IMAGE SOURCE — Multi-source image selection
   ═══════════════════════════════════════════ */

async function getImageForPost(
  imageSource: string,
  caption: string,
  hotelId: number
): Promise<{ mediaId: number | null; imageUrl?: string }> {

  // 1) Google Drive — ảnh thật từ khách sạn
  if (imageSource === 'gdrive') {
    try {
      const folderId = getSetting('gdrive_folder_id', hotelId);
      if (folderId) {
        const img = await getRandomDriveImage(folderId);
        // Mark as used (prefer least-used images)
        db.prepare(`UPDATE gdrive_images SET used_count = used_count + 1, last_used_at = ? WHERE drive_file_id = ? AND hotel_id = ?`)
          .run(Date.now(), img.id, hotelId);

        // Save to media table for post reference
        const result = db.prepare(
          `INSERT INTO media (filename, mime_type, size, source, prompt, hotel_id, created_at)
           VALUES (?, ?, 0, 'gdrive', ?, ?, ?)`
        ).run(img.url, img.mimeType, `GDrive: ${img.name}`, hotelId, Date.now());
        return { mediaId: Number(result.lastInsertRowid), imageUrl: img.url };
      }
    } catch (e: any) {
      console.warn(`[autopilot] GDrive image failed, falling back to AI:`, e.message);
    }
  }

  // 2) Unsplash — stock photos miễn phí
  if (imageSource === 'unsplash' || imageSource === 'web') {
    try {
      const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
      const hotelName = hotel?.name || 'hotel';
      // Extract content type from caption context
      const contentType = caption.includes('tip') ? 'tips' : caption.includes('ẩm thực') ? 'lifestyle' : 'product';
      const photo = await getHotelPhoto(hotelName, contentType);
      if (photo) {
        // Save to media with attribution
        const captionWithCredit = `${caption}\n\n${photo.attribution}`;
        const result = db.prepare(
          `INSERT INTO media (filename, mime_type, size, source, prompt, hotel_id, created_at)
           VALUES (?, 'image/jpeg', 0, 'unsplash', ?, ?, ?)`
        ).run(photo.imageUrl, photo.attribution, hotelId, Date.now());
        return { mediaId: Number(result.lastInsertRowid), imageUrl: photo.imageUrl };
      }
    } catch (e: any) {
      console.warn(`[autopilot] Unsplash failed, falling back to AI:`, e.message);
    }
  }

  // 3) AI-generated image (default fallback)
  try {
    const imgPrompt = await generateImagePrompt(caption);
    const imgResult = await generateImageSmart(imgPrompt);
    if (imgResult.mediaId) {
      db.prepare(`UPDATE media SET hotel_id = ? WHERE id = ?`).run(hotelId, imgResult.mediaId);
    }
    return { mediaId: imgResult.mediaId };
  } catch (e: any) {
    console.warn(`[autopilot] Image gen failed, posting text-only: ${e.message}`);
    return { mediaId: null };
  }
}

/* ═══════════════════════════════════════════
   CAPTION GENERATION — Enhanced with hooks
   ═══════════════════════════════════════════ */

async function generateCaptionWithHook(
  topic: string,
  hookStyle: string,
  contentType: string,
  hotelId: number
): Promise<string> {
  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Khach san';
  const hook = generateHook(hookStyle, hotelName, topic);

  const system = `Ban la copywriter chuyen viet bai Facebook cho khach san ${hotelName}.
Viet 1 caption hap dan, tu nhien, khong qua quang cao.

QUY TAC HOOK:
- Cau DAU TIEN phai la hook hut — dung style "${hookStyle}"
- Hook goi y: "${hook}"
- KHONG bat dau bang emoji — bat dau bang chu

QUY TAC CONTENT:
- Loai noi dung: ${contentType}
${contentType === 'news_brand' ? '- Viet nhu chia se tin tuc ket hop goc nhin khach san' : ''}
${contentType === 'product' || contentType === 'behind_scenes' ? '- Mo ta trai nghiem thuc te tai khach san' : ''}
${contentType === 'community' ? '- Viet nhu ke chuyen khach hang' : ''}
${contentType === 'lifestyle' ? '- Viet phong cach lifestyle, cam hung' : ''}
- Do dai: 150-300 tu
- 3-5 hashtag cuoi bai
- 2-4 emoji xuyen suot (KHONG qua nhieu)
- Ket thuc = CTA (call to action) nhe nhang
- Viet bang tieng Viet, tone than thien, chuyen nghiep`;

  return generate({ task: 'caption', system, user: `Chu de: ${topic}\nViet caption:` });
}

/* ═══════════════════════════════════════════
   RATE LIMITING & SCHEDULING
   ═══════════════════════════════════════════ */

function checkRateLimit(hotelId: number): boolean {
  const hotel = db.prepare(`SELECT max_posts_per_day FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const maxPosts = hotel?.max_posts_per_day || 1;
  const startOfDay = new Date(getVNDate());
  startOfDay.setHours(0, 0, 0, 0);
  const todayPosts = db.prepare(
    `SELECT COUNT(*) as n FROM posts WHERE hotel_id = ? AND created_at >= ?`
  ).get(hotelId, startOfDay.getTime()) as { n: number };
  return todayPosts.n < maxPosts;
}

function getPostTimes(hotelId: number = 1): string[] {
  const setting = getSetting('autopilot_post_times', hotelId);
  if (setting) {
    try { return JSON.parse(setting); } catch { /* fall through */ }
  }
  return ['10:00', '19:00'];
}

function getVNOffset(): number {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const vnTime = utc + 7 * 3600000;
  return vnTime - now.getTime() + now.getTimezoneOffset() * 60000;
}

function getNextPostTime(hotelId: number = 1): number {
  const postTimes = getPostTimes(hotelId);
  const now = getVNDate();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const t of postTimes) {
    const target = new Date(`${todayStr}T${t}:00`);
    const vnOffset = getVNOffset();
    const epoch = target.getTime() - vnOffset;
    if (epoch > Date.now()) return epoch;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const vnOffset = getVNOffset();
  return new Date(`${tomorrowStr}T${postTimes[0]}:00`).getTime() - vnOffset;
}

/* ═══════════════════════════════════════════
   MAIN CYCLE — Run one autopilot post
   ═══════════════════════════════════════════ */

export async function runAutopilotCycle(pageId: number, hotelId: number = 1): Promise<{
  postId: number;
  topic: string;
  caption: string;
  mediaId: number | null;
  scheduledAt: number;
  contentType: string;
  imageSource: string;
  hookStyle: string;
} | null> {
  if (!checkRateLimit(hotelId)) {
    console.log(`[autopilot] Hotel ${hotelId} reached daily post limit, skip`);
    return null;
  }

  const research = await researchTopics(hotelId);
  const topic = research.topics[0];

  // Generate caption with hook
  const caption = await generateCaptionWithHook(topic, research.hookStyle, research.contentType, hotelId);

  // Get image from appropriate source
  const { mediaId } = await getImageForPost(research.imageSource, caption, hotelId);

  const scheduledAt = getNextPostTime(hotelId);

  const result = db.prepare(
    `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, hotel_id, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?)`
  ).run(pageId, caption, mediaId, mediaId ? 'image' : 'none', scheduledAt, hotelId, Date.now());

  const postId = Number(result.lastInsertRowid);
  console.log(`[autopilot] Hotel ${hotelId}: Post #${postId} [${research.contentType}/${research.imageSource}/${research.hookStyle}] topic="${topic}"`);

  return { postId, topic, caption, mediaId, scheduledAt, contentType: research.contentType, imageSource: research.imageSource, hookStyle: research.hookStyle };
}

/* ═══════════════════════════════════════════
   REPORTS
   ═══════════════════════════════════════════ */

export async function generateMorningReport(hotelId: number = 1): Promise<string> {
  const cal = getCalendarDay(hotelId);
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const postTimes = getPostTimes(hotelId);
  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Hotel';

  const research = await researchTopics(hotelId);
  const topicList = research.topics.map((t, i) => `${i + 1}. ${t}`).join('\n');

  return `🌅 BAO CAO SANG — ${hotelName}
📅 ${dateStr}
📋 Pillar: ${cal.pillar_emoji} ${cal.pillar_name} — ${cal.pillar_desc}
📝 Content: ${cal.content_type} | Anh: ${cal.image_source} | Hook: ${cal.hook_style}
📝 Chu de du kien:
${topicList}
💡 Ly do: ${research.reasoning}
⏰ Dang luc: ${postTimes.join(' & ')}`;
}

export async function generateEveningReport(hotelId: number = 1): Promise<string> {
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Hotel';

  const startOfDay = new Date(vnDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(vnDate);
  endOfDay.setHours(23, 59, 59, 999);

  const posts = db.prepare(
    `SELECT id, caption, status, fb_post_id, published_at, error_message
     FROM posts WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC`
  ).all(hotelId, startOfDay.getTime(), endOfDay.getTime()) as any[];

  if (posts.length === 0) {
    return `🌙 BAO CAO TOI — ${hotelName}\n📅 ${dateStr}\n\n📭 Khong co bai dang nao hom nay.`;
  }

  const published = posts.filter(p => p.status === 'published');
  const failed = posts.filter(p => p.status === 'failed');
  const scheduled = posts.filter(p => p.status === 'scheduled');

  let report = `🌙 BAO CAO TOI — ${hotelName}\n📅 ${dateStr}\n\n`;
  report += `📊 Tong ket: ${published.length} dang thanh cong, ${failed.length} that bai, ${scheduled.length} dang cho\n\n`;

  for (const p of published) {
    report += `✅ Post #${p.id}: ${p.caption.slice(0, 80)}...\n`;
  }
  for (const p of failed) {
    report += `❌ Post #${p.id}: ${p.error_message || 'Khong ro loi'}\n`;
  }

  return report.trim();
}

/* ═══════════════════════════════════════════
   STATUS & CALENDAR MANAGEMENT
   ═══════════════════════════════════════════ */

export function getAutopilotStatus(hotelId: number = 1) {
  const enabled = getSetting('autopilot_enabled', hotelId) === '1';
  const postsPerDay = parseInt(getSetting('autopilot_posts_per_day', hotelId) || '2', 10);
  const postTimes = getPostTimes(hotelId);
  const currentPillar = getTodayPillar(hotelId);
  const hotel = db.prepare(`SELECT name, max_posts_per_day FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const calendar = getWeekCalendar(hotelId);
  const gdriveFolder = getSetting('gdrive_folder_id', hotelId);
  const gdriveImageCount = gdriveFolder
    ? (db.prepare(`SELECT COUNT(*) as n FROM gdrive_images WHERE hotel_id = ?`).get(hotelId) as any)?.n || 0
    : 0;

  return {
    enabled,
    postsPerDay,
    postTimes,
    currentPillar,
    calendar,
    hotelName: hotel?.name || 'N/A',
    maxPostsPerDay: hotel?.max_posts_per_day || 1,
    rateLimitOk: checkRateLimit(hotelId),
    gdriveFolder,
    gdriveImageCount,
  };
}

/** Save custom calendar for a hotel */
export function saveCalendarDay(hotelId: number, day: CalendarDay) {
  db.prepare(`
    INSERT INTO content_calendar (hotel_id, day_of_week, content_type, image_source, pillar_name, pillar_emoji, pillar_desc, hook_style, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(hotel_id, day_of_week) DO UPDATE SET
      content_type = excluded.content_type,
      image_source = excluded.image_source,
      pillar_name = excluded.pillar_name,
      pillar_emoji = excluded.pillar_emoji,
      pillar_desc = excluded.pillar_desc,
      hook_style = excluded.hook_style
  `).run(hotelId, day.day_of_week, day.content_type, day.image_source, day.pillar_name, day.pillar_emoji, day.pillar_desc, day.hook_style);
}

/** Sync Google Drive images on demand */
export async function syncGdriveImages(hotelId: number): Promise<number> {
  const folderId = getSetting('gdrive_folder_id', hotelId);
  if (!folderId) throw new Error('Chua cau hinh Google Drive folder ID');
  return syncDriveFolder(folderId, hotelId);
}

/* ═══════════════════════════════════════════
   RUN ALL HOTELS
   ═══════════════════════════════════════════ */

export async function runAutopilotAllHotels() {
  const hotels = db.prepare(
    `SELECT h.id as hotel_id, p.id as page_id
     FROM mkt_hotels h
     JOIN pages p ON p.hotel_id = h.id
     WHERE h.status = 'active'
     AND EXISTS (SELECT 1 FROM settings s WHERE s.key = 'autopilot_enabled' AND s.value = '1' AND s.hotel_id = h.id)
     GROUP BY h.id`
  ).all() as { hotel_id: number; page_id: number }[];

  for (const h of hotels) {
    try {
      await runAutopilotCycle(h.page_id, h.hotel_id);
    } catch (e: any) {
      console.error(`[autopilot] Hotel ${h.hotel_id} error:`, e.message);
    }
  }
}
