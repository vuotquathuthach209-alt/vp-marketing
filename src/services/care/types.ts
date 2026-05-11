/**
 * Customer Care module types.
 *
 * STRATEGY: aggregation + alerting + templates.
 * NO auto-reply. Admin remains the one who responds to customers.
 */

export type ReviewSource = 'facebook' | 'google_maps' | 'instagram' | 'tripadvisor' | 'manual';
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'unknown';

export interface CareReview {
  id: number;
  source: ReviewSource;
  source_id: string;                  // FB recommendation_id, Google review_id, etc.
  hotel_id: number | null;            // sondervn hotel_id if matched
  fb_page_id: string | null;
  author_name: string | null;
  author_id: string | null;
  rating: number | null;              // 1-5 stars (or null for FB recommend yes/no)
  recommendation_type: string | null; // 'positive' | 'negative' (FB) or null
  text: string;
  language: string | null;            // 'vi' | 'en' | etc.
  sentiment: Sentiment;
  sentiment_score: number | null;     // -1 to 1
  sentiment_reason: string | null;    // why classified this way
  is_urgent: 0 | 1;                   // critical issue flagged
  has_response: 0 | 1;                // owner already replied
  response_text: string | null;
  response_at: number | null;
  created_at_source: number;          // when review was made (epoch ms)
  detected_at: number;                // when we pulled it
  last_seen_at: number;               // last time we re-pulled
  notified_admin: 0 | 1;
  notes: string | null;               // admin notes
}

export interface CareComment {
  id: number;
  source: 'facebook' | 'instagram';
  source_id: string;                  // comment_id
  parent_post_id: string | null;      // FB post id
  fb_page_id: string | null;
  author_name: string | null;
  author_id: string | null;
  text: string;
  sentiment: Sentiment;
  sentiment_score: number | null;
  is_question: 0 | 1;                 // detected as question
  needs_response: 0 | 1;
  has_response: 0 | 1;
  detected_at: number;
  notified_admin: 0 | 1;
}

export interface CareMessage {
  id: number;
  source: 'facebook' | 'instagram';
  source_id: string;
  conversation_id: string;
  fb_page_id: string | null;
  sender_psid: string;
  sender_name: string | null;
  text: string;
  is_inbound: 0 | 1;                  // 1 = from customer, 0 = from page
  detected_at: number;
}

export type TemplateCategory =
  | 'greeting' | 'thanks' | 'apology' | 'info_room' | 'info_pricing'
  | 'info_amenities' | 'info_location' | 'response_positive_review'
  | 'response_negative_review' | 'response_question' | 'follow_up' | 'other';

export interface ResponseTemplate {
  id: number;
  category: TemplateCategory;
  trigger_keywords: string;           // JSON array of keywords/intents that match
  language: 'vi' | 'en';
  title: string;                      // admin-visible name
  body: string;                       // template text (supports {{var}} placeholders)
  variables: string;                  // JSON array of {name, label, default}
  hotel_id: number | null;            // null = global, or specific hotel
  active: 0 | 1;
  use_count: number;
  created_at: number;
  updated_at: number;
}

export interface CareNotification {
  id: number;
  type: 'new_negative_review' | 'new_urgent_comment' | 'new_question' | 'response_overdue';
  payload: string;                    // JSON
  notified_via: string;               // 'telegram' | 'email'
  notified_at: number;
}
