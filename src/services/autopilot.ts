import { db, getSetting, setSetting } from '../db';
import { generate } from './router';
import { buildContext } from './wiki';
import { generateCaption, generateImagePrompt } from './claude';
import { generateImageSmart } from './imagegen';
import { config } from '../config';

/* ── Content Pillars (Mon-Sun) ── */
const PILLARS = [
  { day: 'Chủ Nhật', emoji: '❤️', name: 'Community', description: 'Cộng đồng, câu chuyện khách hàng, UGC, review' },
  { day: 'Thứ Hai',  emoji: '🏨', name: 'Product',   description: 'Giới thiệu phòng, dịch vụ, tiện ích khách sạn' },
  { day: 'Thứ Ba',   emoji: '🎯', name: 'Tips',      description: 'Mẹo du lịch, travel tips, hướng dẫn' },
  { day: 'Thứ Tư',   emoji: '📸', name: 'Visual',    description: 'Behind the scenes, ảnh đẹp, reels' },
  { day: 'Thứ Năm',  emoji: '💰', name: 'Promo',     description: 'Khuyến mãi, deal, flash sale, voucher' },
  { day: 'Thứ Sáu',  emoji: '🌟', name: 'Story',     description: 'Câu chuyện thương hiệu, giá trị, sứ mệnh' },
  { day: 'Thứ Bảy',  emoji: '🎉', name: 'Lifestyle', description: 'Lifestyle, ẩm thực, trải nghiệm địa phương' },
];

function getVNDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.tz }));
}

export function getTodayPillar() {
  const dow = getVNDate().getDay(); // 0=Sun
  return PILLARS[dow];
}

/* ── Research Topics ── */
export async function researchTopics(): Promise<{ pillar: string; topics: string[]; reasoning: string }> {
  const pillar = getTodayPillar();
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Gather wiki knowledge
  const brandCtx = await buildContext('brand voice sonder vietnam');
  const pillarCtx = await buildContext('content pillars');
  const seasonCtx = await buildContext('seasonal calendar lịch mùa');
  const audienceCtx = await buildContext('target audience khách hàng mục tiêu');

  const wikiBlock = [brandCtx, pillarCtx, seasonCtx, audienceCtx].filter(Boolean).join('\n\n---\n\n');

  const system = `Bạn là Marketing Strategy Director cho Sonder Vietnam — chuyên gia content marketing ngành lưu trú & du lịch.
Nhiệm vụ: đề xuất 2-3 chủ đề bài đăng Facebook CỤ THỂ, hấp dẫn cho hôm nay.

Yêu cầu:
- Mỗi chủ đề phải đủ cụ thể để viết caption ngay (không chung chung)
- Phù hợp với content pillar hôm nay
- Tận dụng ngữ cảnh mùa vụ, sự kiện nếu có
- Tránh lặp lại chủ đề gần đây
- Trả lời theo đúng format JSON bên dưới, KHÔNG markdown

Format trả về (JSON thuần):
{"topics":["chủ đề 1","chủ đề 2","chủ đề 3"],"reasoning":"lý do chọn ngắn gọn"}`;

  const user = `📅 Hôm nay: ${dateStr}
📋 Content Pillar hôm nay: ${pillar.emoji} ${pillar.name} — ${pillar.description}

--- KIẾN THỨC DOANH NGHIỆP ---
${wikiBlock || '(Chưa có dữ liệu wiki)'}
--- HẾT ---

Hãy đề xuất 2-3 chủ đề cụ thể cho bài đăng hôm nay.`;

  const raw = await generate({ task: 'caption', system, user });

  // Parse JSON from response
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
    // Fallback: extract lines that look like topics
    topics = raw.split('\n').filter(l => l.trim().length > 10).slice(0, 3).map(l => l.replace(/^[\d.\-*]+\s*/, '').trim());
    reasoning = 'Parsed from free-text response';
  }

  if (topics.length === 0) {
    topics = [`${pillar.name}: Giới thiệu trải nghiệm tại Sonder Vietnam`];
    reasoning = 'Fallback — AI không trả về đúng format';
  }

  return { pillar: `${pillar.emoji} ${pillar.name}`, topics, reasoning };
}

/* ── Run one autopilot cycle ── */
export async function runAutopilotCycle(pageId: number): Promise<{
  postId: number;
  topic: string;
  caption: string;
  mediaId: number | null;
  scheduledAt: number;
}> {
  const research = await researchTopics();
  const topic = research.topics[0];

  // Generate caption
  const caption = await generateCaption(topic);

  // Generate image
  let mediaId: number | null = null;
  try {
    const imgPrompt = await generateImagePrompt(caption);
    const imgResult = await generateImageSmart(imgPrompt);
    mediaId = imgResult.mediaId;
  } catch (e: any) {
    console.warn(`[autopilot] Image gen failed, posting text-only: ${e.message}`);
  }

  // Determine next post time
  const scheduledAt = getNextPostTime();

  // Insert scheduled post
  const result = db.prepare(
    `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, ?)`
  ).run(pageId, caption, mediaId, mediaId ? 'image' : 'none', scheduledAt, Date.now());

  const postId = Number(result.lastInsertRowid);
  console.log(`[autopilot] Created post #${postId} topic="${topic}" scheduled=${new Date(scheduledAt).toISOString()}`);

  return { postId, topic, caption, mediaId, scheduledAt };
}

function getNextPostTime(): number {
  const postTimes = getPostTimes();
  const now = getVNDate();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  for (const t of postTimes) {
    const target = new Date(`${todayStr}T${t}:00`);
    // Convert VN time to UTC epoch
    const vnOffset = getVNOffset();
    const epoch = target.getTime() - vnOffset;
    if (epoch > Date.now()) return epoch;
  }

  // All times passed today → schedule first slot tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const vnOffset = getVNOffset();
  return new Date(`${tomorrowStr}T${postTimes[0]}:00`).getTime() - vnOffset;
}

function getVNOffset(): number {
  // Asia/Ho_Chi_Minh = UTC+7 = 7*60*60*1000
  // We need the offset between local parse and actual VN time
  // Since we parse as local, we adjust:
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const vnTime = utc + 7 * 3600000;
  return vnTime - now.getTime() + now.getTimezoneOffset() * 60000;
}

function getPostTimes(): string[] {
  const setting = getSetting('autopilot_post_times');
  if (setting) {
    try { return JSON.parse(setting); } catch { /* fall through */ }
  }
  return ['10:00', '19:00'];
}

/* ── Morning Report ── */
export async function generateMorningReport(): Promise<string> {
  const pillar = getTodayPillar();
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const postTimes = getPostTimes();

  const research = await researchTopics();

  const topicList = research.topics.map((t, i) => `${i + 1}. ${t}`).join('\n');

  return `🌅 BÁO CÁO SÁNG — ${dateStr}
📋 Pillar hôm nay: ${pillar.emoji} ${pillar.name} — ${pillar.description}
📝 Chủ đề dự kiến:
${topicList}
💡 Lý do: ${research.reasoning}
⏰ Đăng lúc: ${postTimes.join(' & ')}`;
}

/* ── Evening Report ── */
export async function generateEveningReport(): Promise<string> {
  const vnDate = getVNDate();
  const dateStr = vnDate.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Get today's start/end in epoch ms
  const startOfDay = new Date(vnDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(vnDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Approximate: query posts created today
  const posts = db.prepare(
    `SELECT id, caption, status, fb_post_id, published_at, error_message
     FROM posts
     WHERE created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC`
  ).all(startOfDay.getTime(), endOfDay.getTime()) as Array<{
    id: number; caption: string; status: string; fb_post_id: string | null;
    published_at: number | null; error_message: string | null;
  }>;

  if (posts.length === 0) {
    return `🌙 BÁO CÁO TỐI — ${dateStr}\n\n📭 Không có bài đăng nào hôm nay.`;
  }

  const published = posts.filter(p => p.status === 'published');
  const failed = posts.filter(p => p.status === 'failed');
  const scheduled = posts.filter(p => p.status === 'scheduled');

  let report = `🌙 BÁO CÁO TỐI — ${dateStr}\n\n`;
  report += `📊 Tổng kết: ${published.length} đăng thành công, ${failed.length} thất bại, ${scheduled.length} đang chờ\n\n`;

  for (const p of published) {
    report += `✅ Post #${p.id}: ${p.caption.slice(0, 80)}...\n`;
  }
  for (const p of failed) {
    report += `❌ Post #${p.id}: ${p.error_message || 'Không rõ lỗi'}\n`;
  }

  return report.trim();
}

/* ── Status ── */
export function getAutopilotStatus() {
  const enabled = getSetting('autopilot_enabled') === '1';
  const postsPerDay = parseInt(getSetting('autopilot_posts_per_day') || '2', 10);
  const postTimes = getPostTimes();
  const currentPillar = getTodayPillar();

  return { enabled, postsPerDay, postTimes, currentPillar };
}
