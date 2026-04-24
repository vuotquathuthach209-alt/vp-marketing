/**
 * Content Discovery — tìm chủ đề tips du lịch HOT.
 *
 * Sources:
 *   - RSS: VNExpress Du lịch, Tuoi Tre Du lịch, Dan Tri Du lịch
 *   - Reddit: r/travel, r/VietNam, r/solotravel (JSON API public)
 *   - AI topic brainstormer (seasonal + evergreen)
 *   - Google Trends (future)
 *
 * Output: rows vào video_content_ideas với relevance_score.
 * Admin browse + pick topic → create project.
 */

import { db } from '../../db';
import axios from 'axios';

export interface ContentIdea {
  id?: number;
  topic: string;
  description?: string;
  target_audience?: string;
  source_url?: string;
  source_type: 'rss' | 'reddit' | 'google_trends' | 'ai_generated' | 'manual';
  relevance_score: number;
  trending_score: number;
  seasonal_tag?: string;
  used_project_id?: number;
  discovered_at: number;
  used_at?: number;
}

// ═══════════════════════════════════════════════════════════
// RSS sources
// ═══════════════════════════════════════════════════════════

const RSS_SOURCES = [
  { url: 'https://vnexpress.net/rss/du-lich.rss', name: 'VNExpress Du lịch' },
  { url: 'https://dulich.tuoitre.vn/rss.htm', name: 'Tuoi Tre Du lịch' },
  { url: 'https://dantri.com.vn/du-lich.rss', name: 'Dan Tri Du lịch' },
];

/**
 * Fetch RSS + extract headlines + score relevance cho travel tips.
 * Simple regex parse (không cần thư viện ngoài).
 */
export async function discoverFromRSS(limit: number = 20): Promise<ContentIdea[]> {
  const ideas: ContentIdea[] = [];

  for (const src of RSS_SOURCES) {
    try {
      const resp = await axios.get(src.url, {
        timeout: 10000,
        headers: { 'User-Agent': 'VideoStudioBot/1.0' },
      });
      const xml = resp.data;

      // Simple regex parse — trích <item><title>...<description>...<link>
      const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
      for (const item of items.slice(0, Math.ceil(limit / RSS_SOURCES.length))) {
        const title = (item.match(/<title>\s*(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?\s*<\/title>/i) || [])[1];
        const desc = (item.match(/<description>\s*(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?\s*<\/description>/i) || [])[1];
        const link = (item.match(/<link>(.+?)<\/link>/i) || [])[1];

        if (!title) continue;

        const cleaned = stripHtml(title).trim();
        const descCleaned = desc ? stripHtml(desc).trim().substring(0, 300) : undefined;

        const relevance = scoreTravelRelevance(cleaned + ' ' + (descCleaned || ''));
        if (relevance < 0.3) continue;  // Skip low-relevance

        ideas.push({
          topic: cleaned.substring(0, 200),
          description: descCleaned,
          source_url: link,
          source_type: 'rss',
          relevance_score: relevance,
          trending_score: 0.5,
          seasonal_tag: detectSeasonalTag(cleaned),
          discovered_at: Date.now(),
        });
      }
    } catch (e: any) {
      console.warn(`[vs-discovery] RSS ${src.name} failed:`, e?.message);
    }
  }

  return ideas;
}

/**
 * Reddit JSON API — public endpoint không cần key.
 */
export async function discoverFromReddit(limit: number = 15): Promise<ContentIdea[]> {
  const subreddits = ['travel', 'VietNam', 'solotravel', 'backpacking'];
  const ideas: ContentIdea[] = [];

  for (const sub of subreddits) {
    try {
      const resp = await axios.get(`https://www.reddit.com/r/${sub}/hot.json`, {
        params: { limit: Math.ceil(limit / subreddits.length) },
        timeout: 10000,
        headers: { 'User-Agent': 'VideoStudioBot/1.0' },
      });

      const posts = resp.data?.data?.children || [];
      for (const p of posts) {
        const title = p.data?.title;
        if (!title) continue;

        // Filter: high upvote ratio + at least 100 upvotes
        if ((p.data.ups || 0) < 100 || (p.data.upvote_ratio || 0) < 0.85) continue;

        const relevance = scoreTravelRelevance(title);
        if (relevance < 0.3) continue;

        ideas.push({
          topic: title.substring(0, 200),
          description: (p.data.selftext || '').substring(0, 300),
          source_url: `https://reddit.com${p.data.permalink}`,
          source_type: 'reddit',
          relevance_score: relevance,
          trending_score: Math.min(1, (p.data.ups || 0) / 10000),
          seasonal_tag: detectSeasonalTag(title),
          discovered_at: Date.now(),
        });
      }
    } catch (e: any) {
      console.warn(`[vs-discovery] Reddit r/${sub} failed:`, e?.message);
    }
  }

  return ideas;
}

/**
 * AI topic brainstormer — Gemini generate evergreen + seasonal travel tips.
 */
export async function brainstormTopicsViaAI(count: number = 10): Promise<ContentIdea[]> {
  try {
    const { smartCascade } = require('../smart-cascade');
    const month = new Date().getMonth() + 1;
    const seasonCtx = getSeasonContext(month);

    const result = await smartCascade({
      system: `Bạn là content planner cho video travel tips. Tạo ${count} chủ đề HOT cho Reels/Shorts tiếng Việt, độ dài 60-120 giây.

Mix:
- 60% evergreen (tips chung luôn phù hợp)
- 40% seasonal (liên quan đến ${seasonCtx})

Tiêu chí chủ đề HOT:
1. Tò mò cao (clickbait OK nhưng không misleading)
2. Giá trị thực tế (tips dùng được)
3. Dễ minh họa bằng clip du lịch
4. Không địa điểm cụ thể (có thể là Sài Gòn, Hà Nội, Đà Nẵng, quốc tế — miễn hot)

OUTPUT JSON ARRAY:
[
  {
    "topic": "5 bí quyết đặt vé máy bay rẻ ít ai biết",
    "description": "Mẹo book vé cuối giờ, compare site, chọn ngày...",
    "target_audience": "du khách trẻ 20-35",
    "relevance_score": 0.9,
    "trending_score": 0.7,
    "seasonal_tag": "evergreen"
  },
  ...
]`,
      user: `Tạo ${count} chủ đề video travel tips hot cho tháng ${month} (${seasonCtx}). Output JSON array.`,
      json: true,
      temperature: 0.9,
      maxTokens: 2000,
      startFrom: 'gemini_flash',
    });

    if (!result?.text) return [];

    let parsed: any;
    try { parsed = JSON.parse(result.text); }
    catch {
      const m = result.text.match(/\[[\s\S]*\]/);
      if (!m) return [];
      try { parsed = JSON.parse(m[0]); } catch { return []; }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((p: any) => p && p.topic)
      .slice(0, count)
      .map((p: any) => ({
        topic: String(p.topic).substring(0, 200),
        description: p.description ? String(p.description).substring(0, 300) : undefined,
        target_audience: p.target_audience ? String(p.target_audience).substring(0, 100) : undefined,
        source_type: 'ai_generated' as const,
        relevance_score: clamp(Number(p.relevance_score) || 0.7, 0, 1),
        trending_score: clamp(Number(p.trending_score) || 0.5, 0, 1),
        seasonal_tag: String(p.seasonal_tag || 'evergreen'),
        discovered_at: Date.now(),
      }));
  } catch (e: any) {
    console.warn('[vs-discovery] AI brainstorm err:', e?.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// Main orchestrate
// ═══════════════════════════════════════════════════════════

export interface DiscoveryRunResult {
  rss_found: number;
  reddit_found: number;
  ai_generated: number;
  saved: number;
  skipped_duplicates: number;
  ts: number;
}

/**
 * Run full discovery pipeline — parallel fetch + save unique ideas.
 */
export async function runDiscovery(): Promise<DiscoveryRunResult> {
  console.log('[vs-discovery] running discovery pipeline...');
  const [rss, reddit, ai] = await Promise.all([
    discoverFromRSS(20),
    discoverFromReddit(15),
    brainstormTopicsViaAI(10),
  ]);

  const all = [...rss, ...reddit, ...ai];
  let saved = 0, skipped = 0;

  for (const idea of all) {
    try {
      // Dedup by topic (case-insensitive)
      const existing = db.prepare(
        `SELECT id FROM video_content_ideas WHERE lower(topic) = lower(?)`
      ).get(idea.topic);
      if (existing) { skipped++; continue; }

      db.prepare(`
        INSERT INTO video_content_ideas
          (topic, description, target_audience, source_url, source_type,
           relevance_score, trending_score, seasonal_tag, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idea.topic,
        idea.description || null,
        idea.target_audience || null,
        idea.source_url || null,
        idea.source_type,
        idea.relevance_score,
        idea.trending_score,
        idea.seasonal_tag || null,
        idea.discovered_at,
      );
      saved++;
    } catch (e: any) {
      console.warn('[vs-discovery] save err:', e?.message);
    }
  }

  console.log(`[vs-discovery] found rss=${rss.length} reddit=${reddit.length} ai=${ai.length} saved=${saved} skipped=${skipped}`);

  return {
    rss_found: rss.length,
    reddit_found: reddit.length,
    ai_generated: ai.length,
    saved,
    skipped_duplicates: skipped,
    ts: Date.now(),
  };
}

/**
 * List ideas chưa dùng, sort by combined score.
 */
export function listUnusedIdeas(limit: number = 50): ContentIdea[] {
  return db.prepare(`
    SELECT * FROM video_content_ideas
    WHERE used_project_id IS NULL
    ORDER BY (relevance_score * 0.6 + trending_score * 0.4) DESC, discovered_at DESC
    LIMIT ?
  `).all(limit) as ContentIdea[];
}

export function markIdeaUsed(ideaId: number, projectId: number): void {
  try {
    db.prepare(`UPDATE video_content_ideas SET used_project_id = ?, used_at = ? WHERE id = ?`)
      .run(projectId, Date.now(), ideaId);
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

const TRAVEL_KEYWORDS = [
  'du lịch', 'travel', 'tour', 'vacation', 'trip',
  'khách sạn', 'hotel', 'homestay', 'resort',
  'điểm đến', 'destination', 'địa điểm',
  'mẹo', 'tips', 'bí quyết', 'hack',
  'ẩm thực', 'food', 'món ăn', 'đặc sản',
  'nghỉ dưỡng', 'relax', 'staycation',
  'phượt', 'backpack', 'solo',
  'check-in', 'sống ảo', 'chụp ảnh',
  'biển', 'beach', 'núi', 'mountain',
  'đà lạt', 'nha trang', 'phú quốc', 'sapa', 'hội an',
  'sài gòn', 'hà nội', 'đà nẵng',
  'thái lan', 'singapore', 'nhật bản', 'hàn quốc', 'bali',
];

function scoreTravelRelevance(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  let matches = 0;
  for (const kw of TRAVEL_KEYWORDS) {
    if (lower.includes(kw)) {
      matches++;
      score += kw.length > 5 ? 0.15 : 0.1;
    }
  }
  // Bonus: "tips"/"mẹo"/"bí quyết" signals → good for video
  if (/\b(tips?|mẹo|bí quyết|hack|bí mật)\b/i.test(lower)) score += 0.2;
  // Bonus: numbered lists ("5 cách", "10 điểm")
  if (/^\d+\s+(cách|điểm|tip|mẹo|bí quyết|địa điểm|lưu ý)/i.test(lower)) score += 0.15;

  return Math.min(1, score);
}

function detectSeasonalTag(text: string): string {
  const lower = text.toLowerCase();
  if (/tết|tet|new year|năm mới/i.test(lower)) return 'tet';
  if (/hè|summer|nghỉ hè/i.test(lower)) return 'summer';
  if (/giáng sinh|christmas|noel/i.test(lower)) return 'christmas';
  if (/thu|autumn|fall/i.test(lower)) return 'autumn';
  if (/đông|winter/i.test(lower)) return 'winter';
  return 'evergreen';
}

function getSeasonContext(month: number): string {
  if ([12, 1, 2].includes(month)) return 'mùa đông / Tết / du lịch nước ngoài tránh rét';
  if ([3, 4, 5].includes(month)) return 'mùa xuân / lễ 30/4-1/5 / du lịch biển miền Trung';
  if ([6, 7, 8].includes(month)) return 'mùa hè / nghỉ hè / gia đình đi biển / du lịch núi mát';
  return 'mùa thu / Giáng sinh / các điểm đến cổ kính';
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
