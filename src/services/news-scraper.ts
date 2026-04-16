import axios from 'axios';

/**
 * News Scraper — fetch trending travel/hotel news from Google News RSS
 * Used to enrich AI-generated content with current events & trends.
 */

const BASE_URL = 'https://news.google.com/rss/search';
const CACHE_TTL = 4 * 3600000; // 4 hours

interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

const cache = new Map<string, { data: NewsItem[]; ts: number }>();

function parseRSS(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '';
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() ?? '';
    if (title) items.push({ title, link, pubDate, source });
  }

  return items;
}

export async function fetchTravelNews(query?: string): Promise<NewsItem[]> {
  const q = query || 'du+lich+khach+san+vietnam';
  const cacheKey = `news:${q}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log('[news] Cache hit for', q);
    return cached.data;
  }

  try {
    const url = `${BASE_URL}?q=${encodeURIComponent(q)}&hl=vi&gl=VN&ceid=VN:vi`;
    const { data: xml } = await axios.get<string>(url, { timeout: 10000 });
    const items = parseRSS(xml).slice(0, 10);

    cache.set(cacheKey, { data: items, ts: Date.now() });
    console.log(`[news] Fetched ${items.length} items for "${q}"`);
    return items;
  } catch (err: any) {
    console.error('[news] Fetch failed:', err.message);
    // Return stale cache if available
    if (cached) {
      console.log('[news] Returning stale cache');
      return cached.data;
    }
    return [];
  }
}

export async function getNewsForContent(hotelName: string): Promise<string> {
  const cityHints = hotelName.replace(/hotel|resort|villa|homestay/gi, '').trim();
  const queries = [
    `du+lich+${cityHints.replace(/\s+/g, '+')}`,
    'du+lich+khach+san+vietnam',
  ];

  try {
    const results = await fetchTravelNews(queries[0]);
    const fallback = results.length >= 3 ? results : await fetchTravelNews(queries[1]);

    if (!fallback.length) return '';

    const summary = fallback
      .slice(0, 5)
      .map((n, i) => `${i + 1}. ${n.title} (${n.source})`)
      .join('\n');

    return `\n--- Tin tức du lịch mới nhất ---\n${summary}\n---\nHãy tham khảo các tin tức trên để tạo nội dung hấp dẫn, thời sự cho khách sạn "${hotelName}".`;
  } catch (err: any) {
    console.error('[news] getNewsForContent failed:', err.message);
    return '';
  }
}
