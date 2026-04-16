import { db, getSetting, setSetting } from '../db';
import { generate } from './router';
import { buildContext } from './wiki';
import { generateCaption, generateImagePrompt } from './claude';
import { generateImageSmart } from './imagegen';
import { config } from '../config';
import { getCachedRoomTypes } from './ota-sync';

/**
 * Sprint 9 Phase 2 — Autopilot per hotel
 *
 * Each hotel has its own:
 * - Content pillars (customizable)
 * - Post schedule (configurable times)
 * - Topic research (using hotel-specific wiki + OTA data)
 * - Rate limiting based on plan (free=1, starter=3, pro=5 posts/day)
 */

/* ── Content Pillars (Mon-Sun) ── */
const DEFAULT_PILLARS = [
  { day: 'Chu Nhat', emoji: '❤️', name: 'Community', description: 'Cong dong, cau chuyen khach hang, UGC, review' },
  { day: 'Thu Hai',  emoji: '🏨', name: 'Product',   description: 'Gioi thieu phong, dich vu, tien ich khach san' },
  { day: 'Thu Ba',   emoji: '🎯', name: 'Tips',      description: 'Meo du lich, travel tips, huong dan' },
  { day: 'Thu Tu',   emoji: '📸', name: 'Visual',    description: 'Behind the scenes, anh dep, reels' },
  { day: 'Thu Nam',  emoji: '💰', name: 'Promo',     description: 'Khuyen mai, deal, flash sale, voucher' },
  { day: 'Thu Sau',  emoji: '🌟', name: 'Story',     description: 'Cau chuyen thuong hieu, gia tri, su menh' },
  { day: 'Thu Bay',  emoji: '🎉', name: 'Lifestyle', description: 'Lifestyle, am thuc, trai nghiem dia phuong' },
];

function getVNDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.tz }));
}

function getPillars(hotelId: number) {
  const custom = getSetting('autopilot_pillars', hotelId);
  if (custom) {
    try { return JSON.parse(custom); } catch { /* fall through */ }
  }
  return DEFAULT_PILLARS;
}

export function getTodayPillar(hotelId: number = 1) {
  const dow = getVNDate().getDay();
  const pillars = getPillars(hotelId);
  return pillars[dow] || DEFAULT_PILLARS[dow];
}

/** Get hotel info for content context */
function getHotelContext(hotelId: number): string {
  const hotel = db.prepare(`SELECT * FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return '';

  const parts: string[] = [];
  parts.push(`Khach san: ${hotel.name}`);

  // Get OTA cached data if linked
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

/* ── Research Topics (per hotel) ── */
export async function researchTopics(hotelId: number = 1): Promise<{ pillar: string; topics: string[]; reasoning: string }> {
  const pillar = getTodayPillar(hotelId);
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const brandCtx = await buildContext('brand voice', hotelId);
  const pillarCtx = await buildContext('content pillars', hotelId);
  const seasonCtx = await buildContext('seasonal calendar', hotelId);
  const hotelCtx = getHotelContext(hotelId);

  const wikiBlock = [brandCtx, pillarCtx, seasonCtx, hotelCtx].filter(Boolean).join('\n\n---\n\n');

  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Khach san';

  const system = `Ban la Marketing Strategy Director cho ${hotelName} — chuyen gia content marketing nganh luu tru & du lich.
Nhiem vu: de xuat 2-3 chu de bai dang Facebook CU THE, hap dan cho hom nay.

Yeu cau:
- Moi chu de phai du cu the de viet caption ngay (khong chung chung)
- Phu hop voi content pillar hom nay
- Tan dung ngu canh mua vu, su kien neu co
- Tranh lap lai chu de gan day
- Tra loi theo dung format JSON ben duoi, KHONG markdown

Format tra ve (JSON thuan):
{"topics":["chu de 1","chu de 2","chu de 3"],"reasoning":"ly do chon ngan gon"}`;

  const user = `📅 Hom nay: ${dateStr}
📋 Content Pillar hom nay: ${pillar.emoji} ${pillar.name} — ${pillar.description}

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
    topics = [`${pillar.name}: Gioi thieu trai nghiem tai ${hotelName}`];
    reasoning = 'Fallback';
  }

  return { pillar: `${pillar.emoji} ${pillar.name}`, topics, reasoning };
}

/* ── Rate limiting ── */
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

/* ── Run one autopilot cycle (per hotel) ── */
export async function runAutopilotCycle(pageId: number, hotelId: number = 1): Promise<{
  postId: number;
  topic: string;
  caption: string;
  mediaId: number | null;
  scheduledAt: number;
} | null> {
  // Rate limit check
  if (!checkRateLimit(hotelId)) {
    console.log(`[autopilot] Hotel ${hotelId} reached daily post limit, skip`);
    return null;
  }

  const research = await researchTopics(hotelId);
  const topic = research.topics[0];

  const caption = await generateCaption(topic);

  let mediaId: number | null = null;
  try {
    const imgPrompt = await generateImagePrompt(caption);
    const imgResult = await generateImageSmart(imgPrompt);
    mediaId = imgResult.mediaId;
    // Tag media with hotel_id
    if (mediaId) {
      db.prepare(`UPDATE media SET hotel_id = ? WHERE id = ?`).run(hotelId, mediaId);
    }
  } catch (e: any) {
    console.warn(`[autopilot] Image gen failed, posting text-only: ${e.message}`);
  }

  const scheduledAt = getNextPostTime(hotelId);

  const result = db.prepare(
    `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, hotel_id, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?)`
  ).run(pageId, caption, mediaId, mediaId ? 'image' : 'none', scheduledAt, hotelId, Date.now());

  const postId = Number(result.lastInsertRowid);
  console.log(`[autopilot] Hotel ${hotelId}: Created post #${postId} topic="${topic}"`);

  return { postId, topic, caption, mediaId, scheduledAt };
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

function getVNOffset(): number {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const vnTime = utc + 7 * 3600000;
  return vnTime - now.getTime() + now.getTimezoneOffset() * 60000;
}

function getPostTimes(hotelId: number = 1): string[] {
  const setting = getSetting('autopilot_post_times', hotelId);
  if (setting) {
    try { return JSON.parse(setting); } catch { /* fall through */ }
  }
  return ['10:00', '19:00'];
}

/* ── Reports (per hotel) ── */
export async function generateMorningReport(hotelId: number = 1): Promise<string> {
  const pillar = getTodayPillar(hotelId);
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const postTimes = getPostTimes(hotelId);

  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const hotelName = hotel?.name || 'Hotel';

  const research = await researchTopics(hotelId);
  const topicList = research.topics.map((t, i) => `${i + 1}. ${t}`).join('\n');

  return `🌅 BAO CAO SANG — ${hotelName}
📅 ${dateStr}
📋 Pillar: ${pillar.emoji} ${pillar.name} — ${pillar.description}
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

/* ── Status (per hotel) ── */
export function getAutopilotStatus(hotelId: number = 1) {
  const enabled = getSetting('autopilot_enabled', hotelId) === '1';
  const postsPerDay = parseInt(getSetting('autopilot_posts_per_day', hotelId) || '2', 10);
  const postTimes = getPostTimes(hotelId);
  const currentPillar = getTodayPillar(hotelId);
  const hotel = db.prepare(`SELECT name, max_posts_per_day FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;

  return {
    enabled,
    postsPerDay,
    postTimes,
    currentPillar,
    hotelName: hotel?.name || 'N/A',
    maxPostsPerDay: hotel?.max_posts_per_day || 1,
    rateLimitOk: checkRateLimit(hotelId),
  };
}

/* ── Run autopilot for ALL active hotels ── */
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
