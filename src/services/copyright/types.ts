/**
 * Copyright verification module — pre-publish image risk assessment.
 *
 * Goal: prevent FB Rights Manager / Image Match takedowns by verifying every
 * image before it gets used in a post.
 *
 * Risk signals checked:
 *   1. Perceptual hash (pHash) — detect dupes within our library
 *   2. EXIF metadata — real camera = lower risk; stripped = suspicious
 *   3. Reverse image search (Google Vision Web Detection API)
 *      → if image found on other sites → risky
 *   4. Pixel-level match with known takedown images
 *   5. Source attribution — Drive divider (anh upload) = safer than scraped
 *
 * Risk score: 0-100. Block threshold default 60.
 */

export type ImageSource =
  | 'sonder_drive'      // anh upload manual vào Drive divider
  | 'sondervn_ota'      // ảnh từ hotel partner đăng lên sondervn.com (HIGH RISK)
  | 'ai_generated'      // Flux / Gemini AI
  | 'stock_pexels'      // Pexels free stock
  | 'stock_unsplash'    // Unsplash free stock
  | 'manual_upload'     // admin upload trực tiếp qua UI
  | 'unknown';

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ImageRiskAssessment {
  image_path: string;
  perceptual_hash: string | null;
  exif_camera: string | null;             // e.g. "Apple iPhone 14"
  exif_taken_at: number | null;
  has_exif: boolean;
  source: ImageSource;
  source_url: string | null;
  // Reverse search results
  web_matches_count: number;              // # of URLs where this image appears online
  web_matches: string[];                  // up to 10 example URLs
  // Internal dupe
  internal_dupe_count: number;            // how many other v5_footage/gdrive_images have same pHash
  internal_dupe_paths: string[];
  // Known bad list
  in_takedown_blacklist: boolean;
  // Computed
  risk_score: number;                     // 0-100
  risk_level: RiskLevel;
  risk_reasons: string[];
  // Verification status
  status: 'pending' | 'approved' | 'rejected' | 'auto_blocked';
  checked_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
  notes: string | null;
}

export interface ReviewQueueItem {
  id: number;
  image_path: string;
  source_table: string;                   // 'v5_footage' | 'gdrive_images' | 'media'
  source_id: number;
  thumbnail_url: string;
  assessment: ImageRiskAssessment;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
}
