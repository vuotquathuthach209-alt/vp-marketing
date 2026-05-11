/**
 * TikTok SEO module.
 *
 * Strategy (Sondervn không có TikTok API access):
 *   1. Manual profile audit — admin enter handle + stats từ TikTok Insights
 *   2. Hashtag research — em build curated list per hotel niche + region
 *   3. Best-practices checklist cho TikTok hotel marketing
 *   4. Future: Apify scraper hoặc TikTok Business API khi Sondervn launch
 *
 * Sondervn hiện CHƯA có TikTok official → module này hỗ trợ:
 *   - Plan launch checklist (profile setup, niche identification)
 *   - Hashtag library per Vietnam hotel niche (Sài Gòn, Đà Nẵng, Đà Lạt...)
 *   - Posting cadence recommendations
 */

import { db } from '../../../db';

/* ───────── Curated TikTok hashtag library (Vietnam hotel niche) ───────── */

interface HashtagSet {
  category: string;
  region?: string;
  tags: string[];
  volume_estimate: 'high' | 'medium' | 'low';
  competition: 'high' | 'medium' | 'low';
  description: string;
}

export const TIKTOK_HASHTAG_LIBRARY: HashtagSet[] = [
  // Vietnam travel — BROAD (high volume, high competition)
  {
    category: 'vietnam_travel',
    tags: ['#dulichvietnam', '#vietnamtravel', '#travelvietnam', '#vietnamtiktok', '#vietnam', '#explorevietnam'],
    volume_estimate: 'high',
    competition: 'high',
    description: 'Quá rộng — chỉ dùng 1-2 tag/post, kết hợp với niche cụ thể',
  },
  // Hotel/lodging — TARGETED
  {
    category: 'hotel_lodging',
    tags: ['#khachsanvietnam', '#homestayvn', '#khachsangiare', '#resortvietnam', '#vietnamhotel', '#hotelvietnam', '#vietnamhomestay', '#airbnbvietnam'],
    volume_estimate: 'medium',
    competition: 'medium',
    description: 'Target khách đang research khách sạn — golden niche',
  },
  // Saigon specific
  {
    category: 'saigon',
    region: 'HCM',
    tags: ['#saigontiktok', '#saigon', '#hochiminhcity', '#khachsansaigon', '#homestaysaigon', '#saigonchecking', '#saigondulich', '#anbansaigon', '#saigon24h'],
    volume_estimate: 'high',
    competition: 'medium',
    description: 'Sài Gòn niche — dùng cho hotel Q1/Q3/Tân Bình/Bình Thạnh',
  },
  // Saigon district-specific (very niche, low competition)
  {
    category: 'saigon_district',
    region: 'HCM',
    tags: ['#quan1saigon', '#tanbinhsaigon', '#tansonnhat', '#binhthanhdistrict', '#quan3', '#phunhuan', '#hemsaigon'],
    volume_estimate: 'low',
    competition: 'low',
    description: 'Long-tail, dễ rank top — kết hợp với broader tags',
  },
  // Da Nang
  {
    category: 'danang',
    region: 'Da Nang',
    tags: ['#danangcity', '#danang', '#khachsandanang', '#myhe', '#bana', '#danangtiktok', '#dulichdanang', '#beachvietnam'],
    volume_estimate: 'high',
    competition: 'medium',
    description: 'Đà Nẵng — beach lovers, family travel',
  },
  // Da Lat
  {
    category: 'dalat',
    region: 'Da Lat',
    tags: ['#dalat', '#dalatcity', '#dalatvietnam', '#dulichdalat', '#khachsandalat', '#homestaydalat', '#dalatromance', '#dalattripchill'],
    volume_estimate: 'high',
    competition: 'medium',
    description: 'Đà Lạt — couple, honeymoon, cool weather',
  },
  // Phu Quoc
  {
    category: 'phuquoc',
    region: 'Phu Quoc',
    tags: ['#phuquoc', '#phuquocisland', '#phuquoctiktok', '#dulichphuquoc', '#khachsanphuquoc', '#phuquocbeach'],
    volume_estimate: 'medium',
    competition: 'medium',
    description: 'Phú Quốc — beach + island vibe',
  },
  // Hoi An
  {
    category: 'hoian',
    region: 'Hoi An',
    tags: ['#hoian', '#hoiancity', '#ancientown', '#dulichhoian', '#khachsanhoian', '#hoianlantern'],
    volume_estimate: 'medium',
    competition: 'low',
    description: 'Hội An — cultural travelers, photogenic',
  },
  // Couple travel
  {
    category: 'couple_travel',
    tags: ['#couplevn', '#weekendgetaway', '#staycationvn', '#romantictrip', '#datedaytrip', '#couplehotelvn'],
    volume_estimate: 'medium',
    competition: 'low',
    description: 'Couple / honeymoon niche — high intent to book',
  },
  // Budget travel
  {
    category: 'budget',
    tags: ['#dulichgiare', '#khachsangiare', '#travelvietnam', '#backpackervn', '#dulichtietkiem', '#homestay'],
    volume_estimate: 'high',
    competition: 'medium',
    description: 'Budget travelers — large audience, mid-conversion',
  },
  // Luxury
  {
    category: 'luxury',
    tags: ['#luxuryhotel', '#luxurytravelvn', '#resortvietnam', '#vietnamluxury', '#5starhotel'],
    volume_estimate: 'low',
    competition: 'low',
    description: 'Luxury niche — small audience but high RPV (revenue per visit)',
  },
  // Food + hotel combo
  {
    category: 'food_travel',
    tags: ['#anuongvietnam', '#streetfoodvietnam', '#vietnameseFood', '#vietnamfoodie', '#mtaybd', '#foodtour'],
    volume_estimate: 'high',
    competition: 'high',
    description: 'Food angle — pair with hotel niche tag',
  },
];

/* ───────── Mock manual audit (no TikTok API yet) ───────── */

export interface TiktokAudit {
  username: string | null;
  status: 'not_launched' | 'launched_no_api' | 'manual_only';
  posts_per_week: number;
  followers: number | null;
  avg_views: number | null;
  avg_engagement_rate: number | null;
  hashtag_count_per_post: number | null;
  uses_trending_sounds: boolean | null;
  bio_quality: 'unknown' | 'weak' | 'ok' | 'strong';
  has_link_in_bio: boolean | null;
  posts_consistency: 'low' | 'medium' | 'high' | 'unknown';
  recommendations: string[];
  hashtag_recommendations: HashtagSet[];
  audited_at: number;
}

/** Save / update TikTok audit (admin manually enters via UI). */
export function saveManualTiktokAudit(opts: {
  username: string;
  followers?: number;
  posts_last_30d?: number;
  avg_views?: number;
  bio_text?: string;
  has_link_in_bio?: boolean;
  uses_trending_sounds?: boolean;
}): TiktokAudit {
  const now = Date.now();
  const postsPerWeek = opts.posts_last_30d ? +(opts.posts_last_30d / (30 / 7)).toFixed(1) : 0;

  // Score bio
  const bio = opts.bio_text || '';
  const bioQuality: TiktokAudit['bio_quality'] =
    bio.length < 30 ? 'weak' :
    bio.length < 80 ? 'ok' :
    bio.length >= 80 && /khach san|hotel|booking|sondervn|VN|du lich/i.test(bio) ? 'strong' : 'ok';

  // Consistency
  const consistency: TiktokAudit['posts_consistency'] =
    postsPerWeek >= 5 ? 'high' :
    postsPerWeek >= 2 ? 'medium' :
    postsPerWeek > 0 ? 'low' : 'unknown';

  const recommendations: string[] = [];
  if (postsPerWeek < 3) recommendations.push(`Cadence ${postsPerWeek}/tuần thấp — TikTok algo ưu tiên 5-7 video/tuần để boost reach.`);
  if (bioQuality === 'weak') recommendations.push('Bio quá ngắn — viết 80-100 ký tự với keyword "khách sạn VN" + emoji + CTA link.');
  if (opts.has_link_in_bio === false) recommendations.push('Chưa có link in bio — gắn sondervn.com (TikTok cho 1 link clickable duy nhất, dùng cho funnel).');
  if (opts.uses_trending_sounds === false) recommendations.push('Không dùng trending sounds — TikTok algo boost video dùng sound trending +30-50% reach.');
  if (!opts.avg_views || opts.avg_views < 1000) recommendations.push('Avg views thấp — thử Reels-style content (BTS quán phở 5h sáng, view balcony, decor phòng).');

  // Pick relevant hashtag sets — broad mix
  const hashtagRecs = TIKTOK_HASHTAG_LIBRARY.filter((h) =>
    ['hotel_lodging', 'saigon', 'saigon_district', 'couple_travel', 'budget'].includes(h.category),
  );

  const audit: TiktokAudit = {
    username: opts.username,
    status: 'manual_only',
    posts_per_week: postsPerWeek,
    followers: opts.followers ?? null,
    avg_views: opts.avg_views ?? null,
    avg_engagement_rate: null,  // can't compute without TikTok API
    hashtag_count_per_post: null,
    uses_trending_sounds: opts.uses_trending_sounds ?? null,
    bio_quality: bioQuality,
    has_link_in_bio: opts.has_link_in_bio ?? null,
    posts_consistency: consistency,
    recommendations,
    hashtag_recommendations: hashtagRecs,
    audited_at: now,
  };

  db.prepare(
    `INSERT OR REPLACE INTO seo_social_audit
     (channel, page_id, profile_id, name, audit_json, score, audited_at)
     VALUES ('tiktok', NULL, ?, ?, ?, ?, ?)`,
  ).run(opts.username, '@' + opts.username, JSON.stringify(audit), 0, now);

  return audit;
}

/** Generate hashtag set recommendation for a specific hotel context. */
export function recommendHashtagsForHotel(opts: {
  hotel_city?: string;
  hotel_district?: string;
  target_audience?: 'budget' | 'couple' | 'family' | 'luxury' | 'business';
  content_angle?: 'room_view' | 'breakfast' | 'amenity' | 'location' | 'guest_story';
}): { primary: string[]; secondary: string[]; niche: string[]; total: string[]; notes: string[] } {
  const primary: string[] = ['#sondervn'];     // always brand
  const secondary: string[] = [];
  const niche: string[] = [];
  const notes: string[] = [];

  const city = (opts.hotel_city || '').toLowerCase();
  // Primary city tags
  if (/saigon|hcm|hồ chí minh|ho chi minh/.test(city)) {
    primary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'saigon')!.tags.slice(0, 2));
  } else if (/da nang|đà nẵng/.test(city)) {
    primary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'danang')!.tags.slice(0, 2));
  } else if (/da lat|đà lạt/.test(city)) {
    primary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'dalat')!.tags.slice(0, 2));
  } else if (/phu quoc|phú quốc/.test(city)) {
    primary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'phuquoc')!.tags.slice(0, 2));
  } else if (/hoi an|hội an/.test(city)) {
    primary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'hoian')!.tags.slice(0, 2));
  }

  // Secondary — hotel category
  secondary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'hotel_lodging')!.tags.slice(0, 3));

  // Audience-targeted
  if (opts.target_audience === 'couple') {
    secondary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'couple_travel')!.tags.slice(0, 3));
  } else if (opts.target_audience === 'budget') {
    secondary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'budget')!.tags.slice(0, 3));
  } else if (opts.target_audience === 'luxury') {
    secondary.push(...TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'luxury')!.tags.slice(0, 3));
  }

  // Niche / long-tail
  const district = (opts.hotel_district || '').toLowerCase();
  if (district) {
    const districtTagSet = TIKTOK_HASHTAG_LIBRARY.find((h) => h.category === 'saigon_district');
    if (districtTagSet) niche.push(...districtTagSet.tags.slice(0, 2));
  }

  // Content angle
  if (opts.content_angle === 'breakfast' || opts.content_angle === 'amenity') {
    niche.push('#breakfastvn', '#hotelreview');
  } else if (opts.content_angle === 'room_view') {
    niche.push('#hotelroom', '#viewfromroom');
  } else if (opts.content_angle === 'guest_story') {
    niche.push('#travelstory', '#guestreview');
  }

  // Dedup
  const all = Array.from(new Set([...primary, ...secondary, ...niche]));

  // Best practice notes
  notes.push(`Total ${all.length} hashtag — TikTok algo prefers 3-5 hashtag (KHÔNG > 10 vì spammy).`);
  notes.push(`Mix: 1-2 BROAD (#dulichvietnam) + 2-3 NICHE (city/district) + 1-2 BRAND (#sondervn) + 1 TRENDING (#fyp đôi khi).`);
  notes.push(`KHÔNG dùng #fyp #foryou liên tục — TikTok đang giảm reach cho posts spam #fyp.`);
  notes.push(`Trending sound > caption: 1 video dùng trending sound = +30% reach vs random sound.`);

  return {
    primary: Array.from(new Set(primary)),
    secondary: Array.from(new Set(secondary)),
    niche: Array.from(new Set(niche)),
    total: all,
    notes,
  };
}

/** Sondervn TikTok launch checklist (chưa có account). */
export function getLaunchChecklist(): { phase: string; tasks: { task: string; done: boolean; effort: string }[] }[] {
  return [
    {
      phase: '1. Setup (Week 1)',
      tasks: [
        { task: 'Tạo TikTok Business account: @sondervn', done: false, effort: '15min' },
        { task: 'Verify via email sondervn.com — unlock Insights', done: false, effort: '5min' },
        { task: 'Bio: 80-100 ký tự với keyword "Khách sạn VN" + "🏨 Đặt phòng nhanh sondervn.com"', done: false, effort: '10min' },
        { task: 'Profile photo: logo Sondervn (high-contrast)', done: false, effort: '5min' },
        { task: 'Cover photo / Story Highlight: hero hotel image', done: false, effort: '10min' },
        { task: 'Link in bio: sondervn.com (TikTok cho 1 link, dùng wisely)', done: false, effort: '2min' },
        { task: 'Connect Instagram (cross-promo)', done: false, effort: '5min' },
      ],
    },
    {
      phase: '2. Content Production (Week 2-4)',
      tasks: [
        { task: 'Pilot 9 videos đầu (grid view) — mix room tour / location / BTS', done: false, effort: '2 ngày shoot + 1 ngày edit' },
        { task: 'Post lịch: T2/T4/T6/CN — 9h sáng + 7h tối (peak time VN)', done: false, effort: 'cron' },
        { task: 'Mỗi video 15-60s, 9:16 vertical, captions on-screen', done: false, effort: '5min/video' },
        { task: 'Dùng trending sounds (check Discover daily)', done: false, effort: '10min/post' },
        { task: 'Hashtag: 3-5 (1 broad + 2-3 niche + 1 brand)', done: false, effort: 'auto từ module này' },
      ],
    },
    {
      phase: '3. Growth (Week 5+)',
      tasks: [
        { task: 'Reply MỖI comment trong 1h đầu (algo boost)', done: false, effort: 'manual' },
        { task: 'Duet/Stitch viral travel content', done: false, effort: '15min/post' },
        { task: 'TikTok LIVE 1-2 lần/tháng — Q&A booking', done: false, effort: '30min/live' },
        { task: 'Track which hashtag → most views (Insights)', done: false, effort: 'weekly review' },
        { task: 'Cross-post FB → TikTok với edited version (KHÔNG repost FB watermark)', done: false, effort: '10min/post' },
      ],
    },
  ];
}
