/**
 * Share Helper — tạo "Share Package" để admin MANUAL share vào FB groups / Zalo groups.
 *
 * Flow:
 *   1. Bot published 1 post (CI weekly, news draft, manual)
 *   2. createSharePackage() → generate copy-ready content + image link + hashtags + suggested groups
 *   3. Push to Telegram staff chat (with buttons: "Shared ✅", "Skip")
 *   4. Admin click copy, paste vào groups — 30s cho 10 groups
 *   5. (Optional) Click "shared to X" → track into shared_to_groups
 */

import { db } from '../db';

export interface SharePackage {
  id: number;
  hotel_id: number;
  source_post_id?: number;
  source_type: string;
  caption: string;
  image_url?: string;
  hashtags: string[];
  suggested_groups: Array<{ name: string; url?: string; category: string }>;
  shared_to_groups: string[];
  status: string;
  created_at: number;
}

/** Hashtag variations theo category để admin chọn. */
const HASHTAG_POOL: Record<string, string[]> = {
  hotel_enthusiasts: ['#KhachSanViet', '#HotelVN', '#DuLichSaiGon', '#StayCation'],
  du_lich: ['#DuLichVN', '#DuLichViet', '#DuLichTuTuc', '#BalocVN', '#TravelVN'],
  digital_nomad: ['#DigitalNomad', '#WorkFromHotel', '#CoworkingVN', '#LongStayVN'],
  homestay_vn: ['#HomestayVN', '#HomestaySaigon', '#AirbnbVN', '#ChoThueCanHo'],
  business_travel: ['#BusinessTravel', '#CorporateStay', '#ConvenienceStay'],
  sonder: ['#SonderVN', '#Sonder', '#SonderAirport'],
};

/** Build package từ 1 published post. */
export function createSharePackage(input: {
  hotel_id: number;
  source_post_id?: number;
  source_type: 'fb_post' | 'ci_remix' | 'news_draft' | 'manual';
  caption: string;
  image_url?: string;
}): SharePackage {
  // Extract existing hashtags từ caption
  const existing = (input.caption.match(/#[\w\u00C0-\u024F\u1E00-\u1EFF]+/g) || []);
  const existingSet = new Set(existing.map(t => t.toLowerCase()));

  // Enrich hashtags theo category Sonder thông thường
  const allHashtags = new Set<string>();
  existing.forEach(t => allHashtags.add(t));

  // Always include Sonder branding
  HASHTAG_POOL.sonder.forEach(t => allHashtags.add(t));

  // Auto-detect categories from caption để suggest thêm tags
  const lower = input.caption.toLowerCase();
  if (/căn hộ|apartment|chdv|thuê tháng/i.test(lower)) {
    HASHTAG_POOL.homestay_vn.forEach(t => allHashtags.add(t));
    HASHTAG_POOL.digital_nomad.slice(0, 2).forEach(t => allHashtags.add(t));
  }
  if (/homestay|gia đình|family/i.test(lower)) {
    HASHTAG_POOL.homestay_vn.forEach(t => allHashtags.add(t));
  }
  if (/khách sạn|hotel|đặt phòng/i.test(lower)) {
    HASHTAG_POOL.hotel_enthusiasts.forEach(t => allHashtags.add(t));
  }
  if (/du lịch|travel|check.?in/i.test(lower)) {
    HASHTAG_POOL.du_lich.forEach(t => allHashtags.add(t));
  }

  // Load suggested groups from DB (admin curated + category match)
  let suggestedGroups: any[] = [];
  try {
    const rows = db.prepare(
      `SELECT name, url, category FROM suggested_fb_groups
       WHERE active = 1 AND (hotel_id = ? OR hotel_id = 0)
       ORDER BY member_count DESC LIMIT 10`
    ).all(input.hotel_id) as any[];
    suggestedGroups = rows;
  } catch {}

  const hashtags = Array.from(allHashtags).slice(0, 12);

  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO share_packages
     (hotel_id, source_post_id, source_type, caption, image_url,
      hashtags, suggested_groups, shared_to_groups, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?)`
  ).run(
    input.hotel_id, input.source_post_id || null,
    input.source_type, input.caption,
    input.image_url || null,
    JSON.stringify(hashtags),
    JSON.stringify(suggestedGroups),
    now, now,
  );

  const id = Number(r.lastInsertRowid);
  return {
    id,
    hotel_id: input.hotel_id,
    source_post_id: input.source_post_id,
    source_type: input.source_type,
    caption: input.caption,
    image_url: input.image_url,
    hashtags,
    suggested_groups: suggestedGroups,
    shared_to_groups: [],
    status: 'pending',
    created_at: now,
  };
}

/** Push share package tới Telegram staff chat. */
export async function pushPackageToTelegram(packageId: number): Promise<boolean> {
  const pkg = db.prepare(`SELECT * FROM share_packages WHERE id = ?`).get(packageId) as any;
  if (!pkg) return false;

  const hashtags = (() => { try { return JSON.parse(pkg.hashtags); } catch { return []; } })();
  const suggestedGroups = (() => { try { return JSON.parse(pkg.suggested_groups); } catch { return []; } })();

  const separator = '\n━━━━━━━━━━━━━━━━━━━━━━\n';

  const msg = `📦 *Share Package #${pkg.id}*\n` +
    `Source: ${pkg.source_type}` +
    (pkg.image_url ? `\n🖼 Image: ${pkg.image_url}` : '') +
    separator +
    `📝 *CAPTION (copy this):*\n` +
    pkg.caption +
    (hashtags.length ? `\n\n${hashtags.join(' ')}` : '') +
    separator +
    (suggestedGroups.length ? `💡 *Gợi ý share vào groups:*\n` + suggestedGroups.slice(0, 8).map((g: any, i: number) => `  ${i + 1}. ${g.name}${g.url ? ' — ' + g.url : ''}`).join('\n') + '\n' : '') +
    `\n\`/share_done ${pkg.id}\` — mark as shared\n` +
    `\`/share_skip ${pkg.id}\` — skip`;

  try {
    const { notifyAll } = require('./telegram');
    await notifyAll(msg);
    db.prepare(`UPDATE share_packages SET pushed_to_telegram_at = ?, updated_at = ? WHERE id = ?`)
      .run(Date.now(), Date.now(), packageId);
    return true;
  } catch (e: any) {
    console.warn('[share-helper] telegram push fail:', e?.message);
    return false;
  }
}

/** Admin mark shared to specific groups. */
export function markShared(packageId: number, groupsShared: string[]): boolean {
  const r = db.prepare(
    `UPDATE share_packages
     SET shared_to_groups = ?, status = 'shared', updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(JSON.stringify(groupsShared), Date.now(), packageId);
  return r.changes > 0;
}

export function dismissPackage(packageId: number): boolean {
  const r = db.prepare(
    `UPDATE share_packages SET status = 'dismissed', updated_at = ? WHERE id = ?`
  ).run(Date.now(), packageId);
  return r.changes > 0;
}

/** List pending packages (cho admin dashboard). */
export function getPendingPackages(hotelId: number, limit: number = 20): any[] {
  const rows = db.prepare(
    `SELECT * FROM share_packages WHERE hotel_id = ? AND status = 'pending' ORDER BY id DESC LIMIT ?`
  ).all(hotelId, limit) as any[];
  for (const r of rows) {
    try { r.hashtags = JSON.parse(r.hashtags || '[]'); } catch { r.hashtags = []; }
    try { r.suggested_groups = JSON.parse(r.suggested_groups || '[]'); } catch { r.suggested_groups = []; }
    try { r.shared_to_groups = JSON.parse(r.shared_to_groups || '[]'); } catch { r.shared_to_groups = []; }
  }
  return rows;
}

/* ═══════════════════════════════════════════
   SUGGESTED GROUPS management
   ═══════════════════════════════════════════ */

export function addSuggestedGroup(input: {
  hotel_id?: number;
  name: string;
  url?: string;
  category?: string;
  member_count?: number;
  notes?: string;
}): number {
  const r = db.prepare(
    `INSERT INTO suggested_fb_groups
     (hotel_id, name, url, category, member_count, notes, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    input.hotel_id || 0,
    input.name, input.url || null,
    input.category || 'hotel_enthusiasts',
    input.member_count || null,
    input.notes || null,
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

/** Seed các groups du lịch VN phổ biến (admin có thể customize sau). */
export function seedDefaultGroups(): number {
  const defaults = [
    { name: 'Hội Du Lịch Việt Nam', category: 'du_lich', member_count: 500000 },
    { name: 'Hội Tìm Khách Sạn Homestay Tốt Giá Rẻ', category: 'homestay_vn', member_count: 300000 },
    { name: 'Phượt Sài Gòn', category: 'du_lich', member_count: 200000 },
    { name: 'Digital Nomads Vietnam', category: 'digital_nomad', member_count: 50000 },
    { name: 'Homestay Sài Gòn', category: 'homestay_vn', member_count: 80000 },
    { name: 'Du lịch giá rẻ', category: 'du_lich', member_count: 400000 },
    { name: 'Cộng đồng thuê nhà nguyên căn/căn hộ TPHCM', category: 'homestay_vn', member_count: 150000 },
    { name: 'Airbnb Hosts Vietnam', category: 'homestay_vn', member_count: 40000 },
  ];

  let created = 0;
  for (const g of defaults) {
    const exists = db.prepare(`SELECT id FROM suggested_fb_groups WHERE name = ?`).get(g.name);
    if (exists) continue;
    addSuggestedGroup(g);
    created++;
  }
  return created;
}
