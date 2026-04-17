/**
 * Auto-wiki from URL — nền của self-serve onboarding.
 * 1. Fetch HTML website của KS
 * 2. Strip thẻ, lấy text content (max 30k chars)
 * 3. Gemini tóm tắt → JSON array 20-30 wiki entries { title, content, tags }
 * 4. Insert vào knowledge_wiki với hotel_id + namespace='auto-site'
 */
import axios from 'axios';
import { db } from '../db';
import { generate } from './router';

const MAX_HTML_CHARS = 80_000;
const MAX_CONTEXT_CHARS = 30_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSite(url: string): Promise<string> {
  const r = await axios.get(url, {
    timeout: 20000,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VPMKT-AutoWiki/1.0)' },
  });
  const html = (r.data || '').toString().slice(0, MAX_HTML_CHARS);
  return stripHtml(html).slice(0, MAX_CONTEXT_CHARS);
}

interface WikiEntry { title: string; content: string; tags?: string[] }

async function extractEntries(siteText: string, industry: string): Promise<WikiEntry[]> {
  const sys = `Bạn là trợ lý trích xuất thông tin cho chatbot khách hàng của 1 doanh nghiệp ngành ${industry}.
Từ nội dung website bên dưới, hãy tạo 15-25 mục wiki (Q-A / fact) giúp chatbot trả lời khách.
Mỗi mục ngắn (≤ 300 ký tự content), rõ ràng, thực tế. KHÔNG bịa thông tin không có trong site.
Tags gợi ý: 'gia', 'dich-vu', 'dia-chi', 'gio-mo', 'uu-dai', 'lien-he', 'tien-nghi', 'menu', 'lien-he'.
Trả về JSON array thuần:
[{"title":"...","content":"...","tags":["..."]}]`;

  const userPrompt = `NỘI DUNG WEBSITE:\n${siteText}\n\nXuất JSON array ngay, không giải thích.`;

  const raw = await generate({ task: 'caption', system: sys, user: userPrompt });

  // Extract JSON
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Gemini không trả về JSON');
  const parsed = JSON.parse(m[0]) as WikiEntry[];
  return parsed
    .filter(e => e && e.title && e.content)
    .map(e => ({
      title: String(e.title).slice(0, 200),
      content: String(e.content).slice(0, 1000),
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 5).map(t => String(t).slice(0, 30)) : [],
    }));
}

export async function autoWikiFromUrl(hotelId: number, url: string): Promise<{ count: number; entries: WikiEntry[] }> {
  const hotel = db.prepare(`SELECT industry FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const industry = hotel?.industry || 'hotel';

  console.log(`[auto-wiki] hotel=${hotelId} url=${url} industry=${industry}`);

  const siteText = await fetchSite(url);
  if (siteText.length < 200) {
    throw new Error('Site trống hoặc bị chặn (JS-rendered?). Thử URL khác.');
  }

  const entries = await extractEntries(siteText, industry);
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, always_inject, active, hotel_id, updated_at, created_at)
     VALUES ('auto-site', ?, ?, ?, ?, 0, 1, ?, ?, ?)`
  );
  const insertMany = db.transaction((list: WikiEntry[]) => {
    for (const [i, e] of list.entries()) {
      const slug = `auto-${hotelId}-${now}-${i}`;
      stmt.run(slug, e.title, e.content, JSON.stringify(e.tags || []), hotelId, now, now);
    }
  });
  insertMany(entries);

  try {
    const { trackEvent } = require('./events');
    trackEvent({ event: 'auto_wiki_seeded', hotelId, meta: { url, count: entries.length } });
  } catch {}

  console.log(`[auto-wiki] hotel=${hotelId} seeded ${entries.length} entries`);
  return { count: entries.length, entries };
}
