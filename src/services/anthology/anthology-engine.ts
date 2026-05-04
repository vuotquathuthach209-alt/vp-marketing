/**
 * Anthology Engine — rotation logic + slot scheduling.
 *
 * Schedule (1 tập/ngày 19:00 VN):
 *   T2 → Linh   | T3 → Tuấn   | T4 → Linh   | T5 → Vy
 *   T6 → Linh   | T7 → Crossover | CN → Khanh/Hà/Tài rotate
 *
 * Reference skill: sonder-storytelling
 */

import { db } from '../../db';

export type CharacterSlug = 'linh' | 'tuan' | 'vy' | 'khanh' | 'ha' | 'tai';

const TZ_OFFSET_MS = 7 * 3600 * 1000;

/**
 * Get day-of-week in VN time (0 = Sun, 6 = Sat)
 */
export function dayOfWeekVN(epochMs: number = Date.now()): number {
  return new Date(epochMs + TZ_OFFSET_MS).getUTCDay();
}

/**
 * Pick character for today's tập based on rotation rules.
 * Returns: { primary_character_slug, is_crossover, secondary_slugs? }
 */
export interface TodayPick {
  primary: CharacterSlug;
  is_crossover: boolean;
  secondary?: CharacterSlug[];
  arc_slug?: string;
  reason: string;
}

export function pickTodayCharacter(epochMs: number = Date.now()): TodayPick {
  const dow = dayOfWeekVN(epochMs);

  // Linh main spine: T2, T4, T6 (Mon, Wed, Fri)
  if (dow === 1 || dow === 3 || dow === 5) {
    return {
      primary: 'linh',
      is_crossover: false,
      arc_slug: 'linh_season_1',
      reason: `dow=${dow} → Linh main spine`,
    };
  }

  // Tuấn anchor: T3 (Tue)
  if (dow === 2) {
    return {
      primary: 'tuan',
      is_crossover: false,
      arc_slug: 'tuan_backstory',
      reason: 'T3 → Tuấn anchor character',
    };
  }

  // Vy: T5 (Thu)
  if (dow === 4) {
    return {
      primary: 'vy',
      is_crossover: false,
      arc_slug: 'vy_cafe',
      reason: 'T5 → Vy external observer',
    };
  }

  // Crossover: T7 (Sat)
  if (dow === 6) {
    // Pick 2 chars cùng frame: Linh + 1 supporting random
    const supporting: CharacterSlug[] = ['tuan', 'vy', 'khanh'];
    const sec = supporting[Math.floor(Math.random() * supporting.length)];
    return {
      primary: 'linh',
      is_crossover: true,
      secondary: [sec],
      arc_slug: 'linh_season_1',
      reason: `T7 → Crossover: Linh + ${sec}`,
    };
  }

  // CN: rotate Khanh/Hà/Tài (least-recently-used)
  const candidates: CharacterSlug[] = ['khanh', 'ha', 'tai'];
  const stats = candidates.map(slug => {
    const row = db.prepare(`SELECT appearance_count FROM story_characters WHERE slug = ?`).get(slug) as any;
    return { slug, count: row?.appearance_count || 0 };
  });
  stats.sort((a, b) => a.count - b.count);
  return {
    primary: stats[0].slug,
    is_crossover: false,
    reason: `CN → rotate (${stats[0].slug} least-used)`,
  };
}

// ═══════════════════════════════════════════════════════════
// Get character + location + values + logos + arc context
// ═══════════════════════════════════════════════════════════

export function getCharacter(slug: string): any {
  return db.prepare(`SELECT * FROM story_characters WHERE slug = ?`).get(slug);
}

export function getLocation(slug: string): any {
  return db.prepare(`SELECT * FROM story_locations WHERE slug = ?`).get(slug);
}

export function getActiveArc(characterSlug: string): any {
  return db.prepare(`
    SELECT * FROM story_arcs
    WHERE character_slug = ? AND status = 'active'
    ORDER BY season_no ASC LIMIT 1
  `).get(characterSlug);
}

/**
 * Pick best location for character + arc.
 * Linh (S1) → Sonder Airport primarily (where she lives)
 * Tuấn → Sonder Airport (his workplace)
 * Vy → Sonder Q1 (cafe across)
 * Others rotate
 */
export function pickLocationForCharacter(charSlug: string, sceneHint?: string): any {
  const charLocationMap: Record<string, string[]> = {
    linh: ['sonder_airport', 'sonder_q1', 'sonder_binh_thanh'],   // Linh wanders
    tuan: ['sonder_airport'],                                      // Tuấn fixed
    vy: ['sonder_q1'],                                             // Vy cafe fixed
    khanh: ['sonder_airport'],                                     // Business hotel
    ha: ['sonder_airport'],                                        // Visiting Linh
    tai: ['sonder_phu_nhuan'],                                     // Tài's home
  };

  const candidates = charLocationMap[charSlug] || ['sonder_airport'];
  const slug = candidates[Math.floor(Math.random() * candidates.length)];
  return getLocation(slug);
}

/**
 * Pick 1-2 brand values for tập (rotate to ensure all 4 covered over time).
 */
export function pickBrandValuesForEpisode(): { values: any[]; keys: string[] } {
  const all = db.prepare(`SELECT * FROM story_brand_values ORDER BY appearance_count ASC`).all() as any[];
  const picked = all.slice(0, 2);  // Take 2 least-used
  return {
    values: picked,
    keys: picked.map(v => v.value_key),
  };
}

/**
 * Pick logo placements based on episode context.
 * Always include watermark. Add 2-3 contextual based on character/scene.
 */
export function pickLogoPlacements(charSlug: string, hasStaff: boolean = false, hasTea: boolean = false, hasCheckIn: boolean = false): any[] {
  const all = db.prepare(`SELECT * FROM story_logo_placements`).all() as any[];
  const map = Object.fromEntries(all.map(p => [p.placement_key, p]));

  const picks = [map.watermark];   // Always
  if (hasStaff) picks.push(map.staff_tag);
  if (hasTea) picks.push(map.tea_cup);
  if (hasCheckIn) picks.push(map.brass_key, map.door_plate);
  if (picks.length < 3) picks.push(map.linen_napkin);
  if (picks.length < 4) picks.push(map.guest_book);

  return picks.filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
// Continuity facts (anti-contradiction)
// ═══════════════════════════════════════════════════════════

/**
 * Get facts established about character so far (for script writer context).
 */
export function getCharacterFacts(slug: string, limit: number = 20): any[] {
  return db.prepare(`
    SELECT fact_key, fact_value, established_at
    FROM story_continuity
    WHERE fact_key LIKE ? AND superseded_at IS NULL
    ORDER BY established_at DESC LIMIT ?
  `).all(`${slug}.%`, limit);
}

/**
 * Save new fact established this episode.
 */
export function saveFact(factKey: string, factValue: string, episodeId: number, notes?: string): void {
  try {
    db.prepare(`
      INSERT INTO story_continuity (fact_key, fact_value, established_episode_id, established_at, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(factKey, factValue, episodeId, Date.now(), notes || null);
  } catch (e: any) { console.warn('[anthology] saveFact:', e?.message); }
}

/**
 * Get N most recent episodes featuring character (for continuity context).
 */
export function getRecentEpisodes(charSlug: string, limit: number = 5): any[] {
  return db.prepare(`
    SELECT e.episode_no, e.title, e.caption, e.beat, e.published_at
    FROM story_episodes e
    WHERE e.character_ids LIKE ?
    ORDER BY e.published_at DESC NULLS LAST, e.id DESC
    LIMIT ?
  `).all(`%"${charSlug}"%`, limit) as any[];
}

/**
 * Increment appearance count after publish.
 */
export function incrementAppearance(charSlug: string): void {
  try {
    db.prepare(`UPDATE story_characters SET appearance_count = appearance_count + 1 WHERE slug = ?`).run(charSlug);
  } catch {}
}

export function incrementLocationAppearance(locId: number): void {
  try {
    db.prepare(`UPDATE story_locations SET appearance_count = appearance_count + 1 WHERE id = ?`).run(locId);
  } catch {}
}

export function incrementValueAppearances(valueKeys: string[]): void {
  for (const k of valueKeys) {
    try {
      db.prepare(`UPDATE story_brand_values SET appearance_count = appearance_count + 1 WHERE value_key = ?`).run(k);
    } catch {}
  }
}

/**
 * Increment arc episodes_published, mark complete if reached planned.
 * Auto-activate next arc nếu có next_arc_slug.
 */
export function advanceArc(arcId: number): void {
  try {
    const arc = db.prepare(`SELECT * FROM story_arcs WHERE id = ?`).get(arcId) as any;
    if (!arc) return;

    const newCount = (arc.episodes_published || 0) + 1;
    db.prepare(`UPDATE story_arcs SET episodes_published = ? WHERE id = ?`).run(newCount, arcId);

    if (newCount >= arc.episodes_planned) {
      db.prepare(`UPDATE story_arcs SET status = 'completed', ended_at = ? WHERE id = ?`).run(Date.now(), arcId);
      console.log(`[anthology] arc ${arc.arc_slug} COMPLETED (${newCount} eps)`);

      // Activate next arc nếu có
      if (arc.next_arc_slug) {
        db.prepare(`UPDATE story_arcs SET status = 'active', started_at = ? WHERE arc_slug = ? AND status = 'planned'`)
          .run(Date.now(), arc.next_arc_slug);
        console.log(`[anthology] activated next arc: ${arc.next_arc_slug}`);
      }
    }
  } catch (e: any) { console.warn('[anthology] advanceArc:', e?.message); }
}
