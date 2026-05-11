/**
 * SEO module types.
 */

export interface SeoPage {
  id: number;
  url: string;
  title: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  canonical_url: string | null;
  h1: string | null;
  h2_count: number;
  word_count: number;
  status_code: number;
  load_time_ms: number;
  has_schema: 0 | 1;
  schema_types: string;            // JSON array of detected @type values
  internal_links: number;
  external_links: number;
  image_count: number;
  images_with_alt: number;
  images_without_alt: number;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  page_type: 'hotel' | 'homepage' | 'category' | 'blog' | 'other';
  language: string | null;          // detected lang attribute
  last_crawled_at: number;
  created_at: number;
}

export type SeoIssueSeverity = 'critical' | 'warning' | 'info';

export type SeoIssueType =
  | 'missing_title' | 'title_too_long' | 'title_too_short' | 'duplicate_title'
  | 'missing_meta_description' | 'meta_too_long' | 'meta_too_short'
  | 'missing_canonical'
  | 'missing_h1' | 'multiple_h1'
  | 'thin_content'                  // < 300 words
  | 'no_schema'
  | 'broken_link' | 'broken_image'
  | 'missing_alt'
  | 'missing_og_image'
  | 'missing_lang'
  | 'slow_load'                     // > 3 seconds
  | 'http_error';

export interface SeoIssue {
  id: number;
  page_id: number;
  type: SeoIssueType;
  severity: SeoIssueSeverity;
  message: string;
  recommendation: string;
  context: string | null;           // e.g. for broken_link: the URL
  fixed: 0 | 1;
  fixed_at: number | null;
  created_at: number;
}

export interface SeoKeyword {
  id: number;
  keyword: string;
  target_url: string | null;
  category: string | null;          // 'location' | 'hotel_type' | 'amenity' | 'brand' | 'other'
  search_volume: number;
  current_rank: number | null;      // 1-100 or null if not in top 100
  prev_rank: number | null;
  last_checked_at: number | null;
  created_at: number;
}

export interface SeoKeywordHistory {
  id: number;
  keyword_id: number;
  rank: number | null;
  checked_at: number;
}

export interface SeoImageAlt {
  id: number;
  image_url: string;
  page_url: string | null;
  current_alt: string | null;
  current_alt_lang: 'vi' | 'en' | null;
  suggested_alt_vi: string | null;
  suggested_alt_en: string | null;
  vision_keywords: string | null;   // JSON array
  status: 'pending' | 'applied' | 'skipped';
  applied_at: number | null;
  created_at: number;
}

export interface SeoSchema {
  id: number;
  hotel_id: number | null;
  schema_type: string;              // 'Hotel' | 'LocalBusiness' | 'Review'
  schema_json: string;              // JSON-LD as string
  applied_to_url: string | null;
  generated_at: number;
}

export interface CrawlResult {
  url: string;
  ok: boolean;
  status: number;
  load_time_ms: number;
  page: Partial<SeoPage> | null;
  issues: Omit<SeoIssue, 'id' | 'page_id' | 'created_at'>[];
  links: { internal: string[]; external: string[] };
  error?: string;
}
