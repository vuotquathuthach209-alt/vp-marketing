/**
 * Google Trends (VN) — tín hiệu xu hướng MIỄN PHÍ để bài SEO bám thời điểm.
 * Lấy "daily trending searches" của Việt Nam qua RSS công khai (KHÔNG cần API key, $0).
 * FAIL-SAFE: lỗi mạng / sai format → trả '' (KHÔNG bao giờ làm hỏng việc sinh bài).
 * Cache 6h trong RAM để không gọi lặp.
 */
import axios from 'axios';

let _cache: { at: number; topics: string[] } | null = null;
const TTL_MS = 6 * 60 * 60 * 1000;

const TREND_URLS = [
  'https://trends.google.com/trending/rss?geo=VN',
  'https://trends.google.com/trends/trendingsearches/daily/rss?geo=VN',
];

/** Danh sách chủ đề đang trending ở VN (rỗng nếu fetch lỗi). */
export async function getVietnamTrends(limit = 12): Promise<string[]> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.topics.slice(0, limit);
  for (const url of TREND_URLS) {
    try {
      const r = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SonderBot/1.0)' },
      });
      const xml = String(r.data || '');
      const topics = xml
        .split('<item>')
        .slice(1)
        .map((chunk) => {
          const m = chunk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
          return m ? m[1].trim() : '';
        })
        .filter((t) => t.length > 1 && t.length < 80);
      if (topics.length) {
        _cache = { at: Date.now(), topics };
        return topics.slice(0, limit);
      }
    } catch {
      /* thử URL kế tiếp */
    }
  }
  return _cache ? _cache.topics.slice(0, limit) : [];
}

/** Đoạn prompt chèn vào bài SEO (rỗng nếu không lấy được — fail-safe). */
export async function trendsPromptBlock(): Promise<string> {
  try {
    const topics = await getVietnamTrends(12);
    if (!topics.length) return '';
    return `\nXU HƯỚNG TÌM KIẾM NỔI BẬT TẠI VN (Google Trends hôm nay): ${topics.join(' · ')}\n- Nếu có chủ đề LIÊN QUAN du lịch / lưu trú / khách sạn / điểm đến trong danh sách trên, hãy lồng ghép TỰ NHIÊN để bài bám thời điểm (KHÔNG gượng ép, KHÔNG spam, chỉ thêm khi thực sự liên quan).`;
  } catch {
    return '';
  }
}
