/**
 * V5 Content Pipeline — Type definitions
 *
 * Reference: skill sonder-content-v5
 *
 * Architecture:
 *   Real footage repository (60% pillar)
 *   + AI-assisted scenes (30%)
 *   + Pure AI generated scenes (10%)
 *   = Hybrid 15-90s clip with 3 hook variants A/B/C
 */

export type V5Theme = 'saigon_insider' | 'sonder_bts';

export type HookPattern =
  | 'textural_asmr'        // Pattern 1: silent visual 0-3s
  | 'time_location'        // Pattern 2: time + location specific
  | 'observational'        // Pattern 3: micro-detail observation
  | 'expectation_reality'  // Pattern 4: expectation vs reality
  | 'numerical_serial'     // Pattern 5: ngày/tuần/lần thứ N
  | 'object_character'     // Pattern 6: object as character reveal
  | 'guest_pov';           // Pattern 7: real guest POV (Khanh, Linh)

/** Real footage clip uploaded từ Sonder staff phone */
export interface FootageClip {
  id: number;
  filename: string;
  path: string;                      // /var/sonder-real-footage/<filename>
  duration_sec: number;
  width: number;
  height: number;                    // expected vertical 9:16
  location: 'airport' | 'q1' | 'binh_thanh' | 'phu_nhuan' | 'cafe_vy' | 'street' | 'other';
  character: 'tuan' | 'linh' | 'vy' | 'khanh' | 'ha' | 'tai' | 'guest' | 'no_face' | null;
  moment_tag: string;                // e.g. "pha_tra_gung", "san_dem_mua"
  uploaded_by: string;               // admin email
  uploaded_at: number;
  used_count: number;                // dedup tracking
  notes: string | null;
  created_at: number;
}

/** Script for 1 V5 clip (with 3 variants) */
export interface V5Script {
  id: number;
  theme: V5Theme;
  title: string;                     // for admin tracking only
  arc_id: number | null;             // optional: link to story arc

  // Body (shared across all 3 variants)
  context_vo: string;                // Layer 2 VO (3-8s)
  encounter_vo: string;              // Layer 3 VO (8-20s)
  reflection_vo: string;             // Layer 5 VO (25-28s)
  closing_vo: string;                // Layer 6 VO (28-30s)

  // Hooks — 3 variants
  hook_a: { pattern: HookPattern; vo_text: string; visual_prompt: string };
  hook_b: { pattern: HookPattern; vo_text: string; visual_prompt: string };
  hook_c: { pattern: HookPattern; vo_text: string; visual_prompt: string };

  // Visual planning
  visual_plan: V5VisualPlan;

  // Loop reward (Layer 6 visual echo)
  loop_reward_visual: string;

  bgm_mood: 'warm' | 'calm' | 'cinematic' | 'intimate' | 'uplifting';
  total_duration_target_sec: number;

  status: 'draft' | 'approved' | 'rendering' | 'rendered' | 'posted' | 'failed';
  created_at: number;
  generated_by: string;              // 'cron-v5' | 'admin-manual' | etc
}

export interface V5VisualPlan {
  shots: V5Shot[];
}

export interface V5Shot {
  shot_no: number;
  start_sec: number;
  end_sec: number;
  source: 'real_footage' | 'ai_image' | 'ai_video' | 'cinema_reuse';
  footage_id?: number;               // if source=real_footage
  ai_prompt?: string;                // if source=ai_*
  ai_provider?: 'fal_flux' | 'fal_wan' | 'fal_animatediff';
  cinema_clip_path?: string;         // if source=cinema_reuse
}

/** Single rendered variant (1 of 3) */
export interface V5RenderedClip {
  id: number;
  script_id: number;
  variant: 'a' | 'b' | 'c';
  hook_pattern: HookPattern;
  output_path: string;               // /var/sonder-v5-out/<filename>.mp4
  duration_sec: number;
  size_mb: number;
  cost_usd: number;                  // FAL cost for this render
  rendered_at: number;
}

/** A/B test result (per platform) */
export interface V5ABResult {
  id: number;
  rendered_clip_id: number;
  platform: 'fb' | 'ig' | 'tiktok' | 'youtube';
  posted_at: number;
  platform_post_id: string;

  // Metrics (updated periodically)
  reach: number;
  views: number;
  completion_rate_halfway: number;   // % users watched halfway
  reactions: number;
  comments: number;
  shares: number;
  dm_shares: number;                 // private DM shares (key signal)
  saves: number;
  first_hour_engagement: number;     // sum reactions+comments+shares 1st hour

  // Verdict
  is_winner: 0 | 1;                  // 1 = winning variant
  killed_at: number | null;          // if killed early
  last_metrics_at: number;
}
