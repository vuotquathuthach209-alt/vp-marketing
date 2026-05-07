/**
 * V5T Text/Image Post — Type definitions
 *
 * Reference: skill sonder-content-v5t
 *
 * 4 post types (40/30/15/15 mix):
 *   - carousel: 4-6 images
 *   - single_image: 1 hero photo
 *   - poll: native FB poll
 *   - question: open-ended question (engagement bait alternative)
 *   - ugc_repost: repost guest's tagged content
 */

export type V5TPostType = 'carousel' | 'single_image' | 'poll' | 'question' | 'ugc_repost';
export type V5TTheme = 'saigon_insider' | 'sonder_bts';
export type V5THookPattern =
  | 'textural_asmr'        // text equivalent: macro/sensory description
  | 'time_location'        // "5h45 sáng. Hẻm Bình Thạnh."
  | 'observational'        // "Đèn hành lang vàng. Không có đèn LED."
  | 'expectation_reality'  // "Tưởng X. Hoá ra Y."
  | 'numerical_serial'     // "Lần thứ 4 anh Khanh đến."
  | 'object_character'     // "Chìa khoá đồng. Tay Linh xoay nhẹ."
  | 'guest_pov';           // "Cô Hà 62t. Lần đầu đi máy bay 1 mình."

export interface V5TPost {
  id: number;
  type: V5TPostType;
  theme: V5TTheme;
  hook_pattern: V5THookPattern | null;
  caption_a: string;
  caption_b: string;
  caption_c: string;
  hashtags: string[];                   // 3-5 niche tags
  poll_question?: string;               // if type=poll
  poll_options?: string[];              // 2-4 options
  status: 'draft' | 'rendered' | 'approved' | 'posted' | 'failed';
  fb_post_id?: string;
  generated_by: string;
  posted_at?: number;
  created_at: number;
}

export interface V5TPostImage {
  id: number;
  post_id: number;
  position: number;                     // 0-based for carousel ordering
  source: 'real_footage' | 'ai_image';
  footage_id?: number;
  ai_prompt?: string;
  composed_path: string;                // final composited image
  width: number;
  height: number;
  has_text_overlay: boolean;
  cost_usd: number;
  created_at: number;
}

export interface V5TABResult {
  id: number;
  post_id: number;
  variant: 'a' | 'b' | 'c';
  caption: string;
  posted_at: number;
  fb_post_id?: string;
  reach: number;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  first_hour_engagement: number;
  is_winner: 0 | 1;
  last_metrics_at?: number;
}
