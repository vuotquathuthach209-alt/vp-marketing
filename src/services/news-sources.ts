/**
 * Whitelist nguồn tin cho News Pipeline.
 *
 * Cấp độ uy tín (source_tier):
 *   AAA: wire services & public broadcasters (Reuters/AP/BBC/AFP)
 *   AA:  industry bodies & specialist publishers (Skift/WTTC/UNWTO/IATA)
 *   A:   mainstream VN newspapers (VnExpress/TuoiTre/VietnamNet/VietnamPlus)
 *
 * CẤM (không có trong list): social media, blog cá nhân, forum, tabloid,
 * clickbait sites, partisan news.
 */

export interface NewsSource {
  id: string;                  // stable id lưu vào DB
  name: string;
  feed_url: string;
  lang: 'en' | 'vi';
  tier: 'AAA' | 'AA' | 'A';
  category: 'general' | 'travel' | 'industry';
  enabled: boolean;
  rate_limit_ms: number;       // giữa 2 lần fetch tới source này
}

/**
 * Danh sách nguồn v1 theo plan (đã duyệt).
 * Admin có thể enable/disable trong dashboard sau (Phase N-5).
 */
export const NEWS_SOURCES: NewsSource[] = [
  // ── AAA — Wire services & public broadcasters (international) ──
  // Reuters: public RSS bị paywall, skip v1.
  // AP News: qua rsshub bị rate limit, skip v1.
  {
    id: 'bbc_world',
    name: 'BBC World News',
    feed_url: 'http://feeds.bbci.co.uk/news/world/rss.xml',
    lang: 'en', tier: 'AAA', category: 'general',
    enabled: true, rate_limit_ms: 2000,
  },
  {
    id: 'bbc_business',
    name: 'BBC Business',
    feed_url: 'http://feeds.bbci.co.uk/news/business/rss.xml',
    lang: 'en', tier: 'AAA', category: 'general',
    enabled: true, rate_limit_ms: 2000,
  },
  {
    id: 'bbc_travel',
    name: 'BBC Travel',
    feed_url: 'https://www.bbc.com/travel/feed.rss',
    lang: 'en', tier: 'AAA', category: 'travel',
    enabled: true, rate_limit_ms: 2000,
  },

  // ── AA — Travel-industry specialist ──
  {
    id: 'skift',
    name: 'Skift',
    feed_url: 'https://skift.com/feed/',
    lang: 'en', tier: 'AA', category: 'industry',
    enabled: true, rate_limit_ms: 2000,
  },
  {
    id: 'hotelmanagement',
    name: 'Hotel Management',
    feed_url: 'https://www.hotelmanagement.net/rss.xml',
    lang: 'en', tier: 'AA', category: 'industry',
    enabled: true, rate_limit_ms: 2000,
  },

  // ── A — Mainstream Vietnam ──
  {
    id: 'vnexpress_dulich',
    name: 'VnExpress — Du lịch',
    feed_url: 'https://vnexpress.net/rss/du-lich.rss',
    lang: 'vi', tier: 'A', category: 'travel',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'vnexpress_the_gioi',
    name: 'VnExpress — Thế giới',
    feed_url: 'https://vnexpress.net/rss/the-gioi.rss',
    lang: 'vi', tier: 'A', category: 'general',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'tuoitre_dulich',
    name: 'Tuổi Trẻ — Du lịch',
    feed_url: 'https://tuoitre.vn/rss/du-lich.rss',
    lang: 'vi', tier: 'A', category: 'travel',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'tuoitre_the_gioi',
    name: 'Tuổi Trẻ — Thế giới',
    feed_url: 'https://tuoitre.vn/rss/the-gioi.rss',
    lang: 'vi', tier: 'A', category: 'general',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'vietnamnet_dulich',
    name: 'VietnamNet — Du lịch',
    feed_url: 'https://vietnamnet.vn/rss/du-lich.rss',
    lang: 'vi', tier: 'A', category: 'travel',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'vietnamplus_dulich',
    name: 'VietnamPlus — Du lịch',
    feed_url: 'https://www.vietnamplus.vn/rss/du-lich.rss',
    lang: 'vi', tier: 'A', category: 'travel',
    enabled: true, rate_limit_ms: 1500,
  },
  {
    id: 'vietnamnet_the_gioi',
    name: 'VietnamNet — Thế giới',
    feed_url: 'https://vietnamnet.vn/rss/the-gioi.rss',
    lang: 'vi', tier: 'A', category: 'general',
    enabled: true, rate_limit_ms: 1500,
  },
];

/** Lấy list enabled sources */
export function getEnabledSources(): NewsSource[] {
  return NEWS_SOURCES.filter(s => s.enabled);
}

export function getSourceById(id: string): NewsSource | undefined {
  return NEWS_SOURCES.find(s => s.id === id);
}
