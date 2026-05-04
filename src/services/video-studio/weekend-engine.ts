/**
 * Weekend Special Engine — Rail C (CN 19:00, 1 video/tuần).
 *
 * 4 themes rotation theo Sunday-of-month:
 *   Sun #1 → day_in_area    — "1 ngày ở [khu vực]" (Q1/Tân Bình/Bình Thạnh)
 *   Sun #2 → inside_sonder  — "Trong phòng Sonder có gì?" (showcase 1 feature)
 *   Sun #3 → guest_story    — "Khách [country] đến Sonder vì..."
 *   Sun #4 → why_sonder     — "Why Sonder không giống KS thường"
 *   Sun #5 → rotates back to day_in_area (rare 5th Sunday)
 *
 * Format video 90-120s:
 *   - 8-10 scenes × 10-15s
 *   - Higher production: 50% AI image gen + 50% Pexels stock
 *   - Cinematic compose (curves, film grain, vignette)
 *   - Custom AI thumbnail
 *   - Cost target: ~$2/video
 */

import { db } from '../../db';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type WeekendThemeType = 'day_in_area' | 'inside_sonder' | 'guest_story' | 'why_sonder';

export interface WeekendScene {
  scene_idx: number;
  beat: 'hook' | 'context' | 'feature' | 'detail' | 'payoff' | 'cta';
  text: string;                     // VN voiceover
  duration_sec: number;
  visual_prompt: string;            // English AI image prompt
  visual_query: string;             // English Pexels keywords
  mood: 'calm' | 'warm' | 'uplifting' | 'cinematic' | 'intimate';
  camera: 'wide' | 'medium' | 'close-up' | 'aerial' | 'pov';
  prefer_visual: 'ai' | 'stock';    // hint for visual fetcher
  overlay_text?: string;            // optional on-screen overlay (timeline like "07:00")
}

export interface WeekendScript {
  theme_type: WeekendThemeType;
  theme_subject: string;            // "Q1" / "Sonder Airport bồn tắm" / "Korean guest" / etc.
  topic: string;
  hook_text: string;
  cta_text: string;
  caption_text: string;
  hashtags: string[];
  scenes: WeekendScene[];
  total_duration_sec: number;
  thumbnail_prompt: string;         // separate prompt for custom thumbnail
}

// ═══════════════════════════════════════════════════════════
// Theme rotation — Sunday of month
// ═══════════════════════════════════════════════════════════

const THEME_ROTATION: WeekendThemeType[] = [
  'day_in_area',     // Sun 1
  'inside_sonder',   // Sun 2
  'guest_story',     // Sun 3
  'why_sonder',      // Sun 4
  'day_in_area',     // Sun 5 (rare, rotate back)
];

/**
 * Find Sunday-of-month index (1-5) for a given date.
 * 1st Sunday = Sun #1, 2nd Sunday = Sun #2, etc.
 */
export function getSundayOfMonth(date: Date = new Date()): { sundayNum: number; isSunday: boolean; sundayDate: Date } {
  // VN time
  const vnTime = new Date(date.getTime() + 7 * 3600 * 1000);
  const dayOfWeek = vnTime.getUTCDay();   // 0=Sun
  const isSunday = dayOfWeek === 0;

  if (!isSunday) {
    // Find next Sunday
    const daysUntilSun = (7 - dayOfWeek) % 7;
    const next = new Date(vnTime);
    next.setUTCDate(vnTime.getUTCDate() + daysUntilSun);
    return { sundayNum: 0, isSunday: false, sundayDate: next };
  }

  // Calculate which Sunday of the month
  const dayOfMonth = vnTime.getUTCDate();
  const sundayNum = Math.ceil(dayOfMonth / 7);
  return { sundayNum: Math.min(5, sundayNum), isSunday: true, sundayDate: vnTime };
}

export function getThemeForToday(): { theme: WeekendThemeType; sundayNum: number } | null {
  const r = getSundayOfMonth();
  if (!r.isSunday) return null;
  const theme = THEME_ROTATION[Math.min(4, r.sundayNum - 1)];
  return { theme, sundayNum: r.sundayNum };
}

/** ISO week format "YYYY-Www" cho dedup. */
export function getISOWeek(date: Date = new Date()): string {
  const target = new Date(date.valueOf());
  const dayNr = (date.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const week = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════
// Theme metadata + subject pools
// ═══════════════════════════════════════════════════════════

export const THEME_METADATA: Record<WeekendThemeType, {
  label: string;
  description: string;
  subjects: string[];                 // pool of possible subjects
  scenes_target: number;              // how many scenes
  duration_target_sec: number;
  voice_style: 'professional' | 'warm' | 'storytelling';
  bgm_mood: string;
}> = {
  day_in_area: {
    label: 'Một ngày ở khu vực',
    description: '8 scenes × 12s timeline morning → night ở 1 khu vực Sonder',
    subjects: [
      'Q1 (gần Bùi Viện)',
      'Tân Bình (gần sân bay)',
      'Bình Thạnh (gần Landmark 81)',
      'Phú Nhuận',
      'Q3 (Hồ Con Rùa)',
    ],
    scenes_target: 8,
    duration_target_sec: 100,
    voice_style: 'warm',
    bgm_mood: 'uplifting',
  },

  inside_sonder: {
    label: 'Trong phòng Sonder có gì',
    description: 'Showcase 1 feature đặc biệt: bồn tắm view / sân thượng / bếp / máy giặt',
    subjects: [
      'phòng có bồn tắm view',
      'studio có ban công nhìn ra thành phố',
      'CHDV có bếp đầy đủ',
      'phòng pet-friendly',
      'phòng family với 2 phòng ngủ',
      'phòng có máy giặt riêng',
      'rooftop view sunset',
    ],
    scenes_target: 8,
    duration_target_sec: 95,
    voice_style: 'professional',
    bgm_mood: 'cinematic',
  },

  guest_story: {
    label: 'Câu chuyện khách',
    description: 'Storytelling 1 specific guest từ 1 country đặt Sonder vì lý do cụ thể',
    subjects: [
      'Khách Hàn Quốc đến SG cho business trip',
      'Cặp đôi Singapore tuần trăng mật',
      'Khách Nhật trip 1 mình',
      'Gia đình Úc với 2 con nhỏ',
      'Khách Mỹ làm remote work 2 tuần',
      'Khách Đài Loan business meeting',
      'Influencer Thái Lan content trip',
    ],
    scenes_target: 9,
    duration_target_sec: 110,
    voice_style: 'storytelling',
    bgm_mood: 'warm',
  },

  why_sonder: {
    label: 'Why Sonder',
    description: 'Brand value pitch — 4-5 differentiators vs khách sạn truyền thống',
    subjects: [
      'Tại sao chọn Sonder thay vì khách sạn 5 sao',
      'Sonder vs Airbnb — khác biệt thật sự',
      '5 điều mà khách sạn không có nhưng Sonder có',
      'Sonder cho người yêu local Vietnamese',
      'Why business travelers chọn Sonder',
    ],
    scenes_target: 8,
    duration_target_sec: 100,
    voice_style: 'professional',
    bgm_mood: 'cinematic',
  },
};

// ═══════════════════════════════════════════════════════════
// Subject picker (rotate within theme to avoid duplicates)
// ═══════════════════════════════════════════════════════════

export function pickSubjectForTheme(theme: WeekendThemeType): string {
  const meta = THEME_METADATA[theme];
  const pool = meta.subjects;

  // Pick subject least-recently used for this theme
  const recentlyUsed = db.prepare(`
    SELECT theme_subject, MAX(created_at) as last_used
    FROM weekend_videos
    WHERE theme_type = ?
    GROUP BY theme_subject
  `).all(theme) as any[];

  const usedMap = new Map<string, number>();
  for (const r of recentlyUsed) usedMap.set(r.theme_subject, r.last_used);

  // Score each subject: lower last_used = higher priority. Never used = highest.
  let best = pool[0];
  let bestScore = -Infinity;
  for (const s of pool) {
    const lastUsed = usedMap.get(s);
    const score = lastUsed ? -lastUsed : Date.now() * 2;   // never-used wins
    if (score > bestScore) { bestScore = score; best = s; }
  }

  return best;
}

// ═══════════════════════════════════════════════════════════
// Theme log helpers (cron dedup)
// ═══════════════════════════════════════════════════════════

export function getThisWeekLog(): any | null {
  const isoWeek = getISOWeek();
  return db.prepare(`SELECT * FROM weekend_theme_log WHERE iso_week = ?`).get(isoWeek) as any;
}

export function logThemeRun(opts: {
  isoWeek: string;
  sundayDate: number;
  sundayNum: number;
  themeType: WeekendThemeType;
  themeSubject: string;
  videoId?: number;
  status?: string;
}): void {
  try {
    db.prepare(`
      INSERT INTO weekend_theme_log (iso_week, sunday_date, sunday_of_month, theme_type, theme_subject, video_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(iso_week) DO UPDATE SET
        theme_subject = excluded.theme_subject,
        video_id = excluded.video_id,
        status = excluded.status
    `).run(
      opts.isoWeek,
      opts.sundayDate,
      opts.sundayNum,
      opts.themeType,
      opts.themeSubject,
      opts.videoId || null,
      opts.status || 'planned',
      Date.now(),
    );
  } catch (e: any) { console.warn('[weekend-engine] log err:', e?.message); }
}
