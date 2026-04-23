import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
if (!fs.existsSync(config.mediaDir)) fs.mkdirSync(config.mediaDir, { recursive: true });
if (!fs.existsSync(config.uploadsDir)) fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fb_page_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL,      -- 'upload' | 'ai-image' | 'ai-video'
  prompt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  caption TEXT NOT NULL,
  media_id INTEGER,
  media_type TEXT,           -- 'none' | 'image' | 'video'
  status TEXT NOT NULL,      -- 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed'
  scheduled_at INTEGER,      -- epoch ms
  published_at INTEGER,
  fb_post_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (media_id) REFERENCES media(id)
);

CREATE INDEX IF NOT EXISTS idx_posts_status_sched ON posts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  topics TEXT NOT NULL,        -- JSON array
  times TEXT NOT NULL,         -- JSON array of "HH:MM"
  with_image INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_runs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id)
);

CREATE TABLE IF NOT EXISTS auto_reply_config (
  page_id INTEGER PRIMARY KEY,
  reply_comments INTEGER NOT NULL DEFAULT 0,
  reply_messages INTEGER NOT NULL DEFAULT 0,
  system_prompt TEXT DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id)
);

CREATE TABLE IF NOT EXISTS auto_reply_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  fb_id TEXT NOT NULL UNIQUE,
  original_text TEXT,
  reply_text TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

-- Số liệu post pull từ FB Insights (reach, engagement, click, ...)
CREATE TABLE IF NOT EXISTS post_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  fb_post_id TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  reactions INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  engagement_rate REAL DEFAULT 0,
  snapshot_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_metrics_post ON post_metrics(post_id);

-- A/B testing: 2 variant hook cho cùng 1 chủ đề
CREATE TABLE IF NOT EXISTS ab_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  variant_a_post_id INTEGER,
  variant_b_post_id INTEGER,
  variant_a_caption TEXT,
  variant_b_caption TEXT,
  winner TEXT,                -- 'A' | 'B' | null
  winner_score REAL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id)
);

-- Wiki-style knowledge base cho AI
CREATE TABLE IF NOT EXISTS knowledge_wiki (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,     -- 'business' | 'product' | 'campaign' | 'faq' | 'lesson'
  slug TEXT NOT NULL,          -- 'sonder-overview', 'room-deluxe', ...
  title TEXT NOT NULL,
  content TEXT NOT NULL,       -- Markdown
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON array
  always_inject INTEGER NOT NULL DEFAULT 0,  -- 1 = luôn đưa vào context
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(namespace, slug)
);
CREATE INDEX IF NOT EXISTS idx_wiki_ns_active ON knowledge_wiki(namespace, active);
`);

// Sprint 4: thêm cột embedding (BLOB = Float32Array) cho semantic search
try {
  const cols = db.prepare(`PRAGMA table_info(knowledge_wiki)`).all() as { name: string }[];
  if (!cols.find((c) => c.name === 'embedding')) {
    db.exec(`ALTER TABLE knowledge_wiki ADD COLUMN embedding BLOB`);
    db.exec(`ALTER TABLE knowledge_wiki ADD COLUMN embedding_model TEXT`);
  }
} catch (e) {
  console.error('[db] migrate embedding failed:', e);
}

// Sprint 5: AI usage log (cost tracker)
db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_log(created_at);

-- Sprint 6: Telegram bot — chat được uỷ quyền điều khiển fanpage
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  authorized INTEGER NOT NULL DEFAULT 0,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Sprint 8: Booking flow
CREATE TABLE IF NOT EXISTS pending_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_sender_id TEXT NOT NULL,
  fb_sender_name TEXT,
  room_type TEXT,
  checkin_date TEXT,
  checkout_date TEXT,
  nights INTEGER DEFAULT 1,
  guests INTEGER DEFAULT 1,
  total_price INTEGER DEFAULT 0,
  deposit_amount INTEGER DEFAULT 0,
  transfer_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'collecting',
  assigned_room TEXT,
  reject_reason TEXT,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON pending_bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_sender ON pending_bookings(fb_sender_id);

-- Sprint 9: Per-hotel Telegram bot config
CREATE TABLE IF NOT EXISTS hotel_telegram_config (
  page_id INTEGER PRIMARY KEY,
  telegram_bot_token TEXT,
  telegram_group_id TEXT,
  bot_username TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  unlock_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id)
);
`);

// ══════════════════════════════════════════════════════
// Sprint 9 Phase 1: MULTI-TENANT TABLES + MIGRATION
// ═════���════════════════════════════════════════════════

// 1.2 MKT Hotels — per-hotel config lưu riêng, link tới OTA hotel_id
db.exec(`
CREATE TABLE IF NOT EXISTS mkt_hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ota_hotel_id INTEGER,                -- ID trên OTA DB (hotels.id), NULL nếu chưa link
  name TEXT NOT NULL,
  slug TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- free | starter | pro | enterprise
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | suspended | cancelled
  config TEXT DEFAULT '{}',            -- JSON: bank_info, deposit_%, cancel_policy, etc.
  features TEXT DEFAULT '{}',          -- JSON: {chatbot:true, autopilot:true, booking:true}
  max_posts_per_day INTEGER DEFAULT 1,
  max_pages INTEGER DEFAULT 1,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mkt_hotels_ota ON mkt_hotels(ota_hotel_id);
CREATE INDEX IF NOT EXISTS idx_mkt_hotels_status ON mkt_hotels(status);

-- 1.4 MKT Users — login bằng email OTA, role per hotel
CREATE TABLE IF NOT EXISTS mkt_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  hotel_id INTEGER NOT NULL,            -- FK → mkt_hotels.id
  ota_owner_id INTEGER,                 -- hotel_owners.id trên OTA DB
  role TEXT NOT NULL DEFAULT 'owner',   -- superadmin | owner | staff
  display_name TEXT,
  last_login INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(email, hotel_id),
  FOREIGN KEY (hotel_id) REFERENCES mkt_hotels(id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_users_email ON mkt_users(email);

-- 1.3 MKT Permissions — feature flags per hotel
CREATE TABLE IF NOT EXISTS mkt_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  feature TEXT NOT NULL,                -- chatbot | autopilot | booking | analytics | ab_test
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT DEFAULT '{}',             -- JSON: feature-specific limits
  updated_at INTEGER NOT NULL,
  UNIQUE(hotel_id, feature),
  FOREIGN KEY (hotel_id) REFERENCES mkt_hotels(id)
);

-- 1.6 Cache tables: sync từ OTA DB (read-only) → lưu local
CREATE TABLE IF NOT EXISTS mkt_hotels_cache (
  ota_hotel_id INTEGER PRIMARY KEY,
  name TEXT,
  slug TEXT,
  address TEXT,
  city TEXT,
  district TEXT,
  star_rating INTEGER,
  phone TEXT,
  check_in_time TEXT,
  check_out_time TEXT,
  amenities TEXT,                      -- JSON
  cancellation_policy TEXT,            -- JSON
  owner_name TEXT,
  owner_email TEXT,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mkt_rooms_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ota_hotel_id INTEGER NOT NULL,
  ota_room_type_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  base_price INTEGER DEFAULT 0,
  hourly_price INTEGER,
  max_guests INTEGER DEFAULT 2,
  bed_type TEXT,
  amenities TEXT,                      -- JSON
  room_count INTEGER DEFAULT 0,
  available_count INTEGER DEFAULT 0,
  synced_at INTEGER NOT NULL,
  UNIQUE(ota_hotel_id, ota_room_type_id)
);
CREATE INDEX IF NOT EXISTS idx_rooms_cache_hotel ON mkt_rooms_cache(ota_hotel_id);

CREATE TABLE IF NOT EXISTS mkt_bookings_cache (
  ota_booking_id INTEGER PRIMARY KEY,
  ota_hotel_id INTEGER NOT NULL,
  booking_code TEXT,
  room_number TEXT,
  room_type_name TEXT,
  guest_name TEXT,
  guest_phone TEXT,
  booking_type TEXT,
  checkin_date TEXT,
  checkout_date TEXT,
  nights INTEGER DEFAULT 1,
  total_price INTEGER DEFAULT 0,
  payment_status TEXT,
  booking_status TEXT,
  channel_name TEXT,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_cache_hotel ON mkt_bookings_cache(ota_hotel_id);
CREATE INDEX IF NOT EXISTS idx_bookings_cache_date ON mkt_bookings_cache(checkin_date);

-- Phase 4: Subscription requests
CREATE TABLE IF NOT EXISTS subscription_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  current_plan TEXT NOT NULL,
  requested_plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | rejected
  payment_ref TEXT DEFAULT '',
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (hotel_id) REFERENCES mkt_hotels(id)
);
CREATE INDEX IF NOT EXISTS idx_sub_requests_hotel ON subscription_requests(hotel_id);

-- Phase 4: Payments
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  hotel_id INTEGER NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,           -- VND
  method TEXT NOT NULL,              -- vnpay | momo | bank_transfer
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | pending_verify | success | failed
  transaction_ref TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (hotel_id) REFERENCES mkt_hotels(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_hotel ON payments(hotel_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- AI Cache: reduce duplicate API calls
CREATE TABLE IF NOT EXISTS ai_cache (
  prompt_hash TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'content',
  response TEXT NOT NULL,
  hotel_id INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (prompt_hash, type)
);

-- Room images: hotel-uploaded room photos
CREATE TABLE IF NOT EXISTS room_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_type_name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  display_order INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_images_hotel ON room_images(hotel_id);

-- Email log
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',  -- sent | failed
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_email);

-- Google Drive synced images
CREATE TABLE IF NOT EXISTS gdrive_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT DEFAULT 'image/jpeg',
  view_url TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  synced_at INTEGER NOT NULL,
  UNIQUE(hotel_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS idx_gdrive_hotel ON gdrive_images(hotel_id);

-- Content calendar: weekly content strategy per hotel
CREATE TABLE IF NOT EXISTS content_calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,          -- 0=Sun, 1=Mon, ..., 6=Sat
  content_type TEXT NOT NULL,             -- hotel_photo | news_brand | web_inspiration | community | lifestyle | tips | product
  image_source TEXT NOT NULL DEFAULT 'ai', -- gdrive | web | ai | unsplash
  pillar_name TEXT NOT NULL,
  pillar_emoji TEXT NOT NULL DEFAULT '📝',
  pillar_desc TEXT NOT NULL DEFAULT '',
  hook_style TEXT DEFAULT 'question',     -- question | fomo | story | stats | tips | controversial
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(hotel_id, day_of_week)
);
CREATE INDEX IF NOT EXISTS idx_calendar_hotel ON content_calendar(hotel_id);

-- Customer contacts: captured phone numbers when bot can't close
CREATE TABLE IF NOT EXISTS customer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  phone TEXT NOT NULL,
  page_id INTEGER NOT NULL DEFAULT 0,
  hotel_id INTEGER NOT NULL DEFAULT 1,
  last_intent TEXT,
  last_message TEXT,
  context TEXT DEFAULT '[]',
  notified_staff INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_sender ON customer_contacts(sender_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON customer_contacts(phone);

-- Conversation memory: store recent messages per sender for context
CREATE TABLE IF NOT EXISTS conversation_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  role TEXT NOT NULL,          -- 'user' | 'bot'
  message TEXT NOT NULL,
  intent TEXT,                 -- detected intent: greeting, price, rooms, booking, etc.
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_convo_sender ON conversation_memory(sender_id, created_at);

-- Learned Q-A cache: patterns promoted from real conversations.
-- Runtime lookup happens BEFORE AI generation — cache hit skips LLM entirely.
-- hits counter drives lazy promotion (hits >= 3 → trusted for serving).
CREATE TABLE IF NOT EXISTS learned_qa_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  question_embedding BLOB,      -- 768-dim Float32Array
  answer TEXT NOT NULL,
  intent TEXT,
  hits INTEGER NOT NULL DEFAULT 1,
  last_hit_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_hotel_hits ON learned_qa_cache(hotel_id, hits DESC);
CREATE INDEX IF NOT EXISTS idx_learned_last_hit ON learned_qa_cache(last_hit_at);

-- v2 Phase 1: Guest profiles (memory across sessions)
CREATE TABLE IF NOT EXISTS guest_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  fb_user_id TEXT,
  phone TEXT,
  name TEXT,
  language TEXT DEFAULT 'vi',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  booked_count INTEGER NOT NULL DEFAULT 0,
  preferences TEXT DEFAULT '{}',
  UNIQUE(hotel_id, fb_user_id)
);
CREATE INDEX IF NOT EXISTS idx_guest_hotel ON guest_profiles(hotel_id, last_seen DESC);

-- v2 Phase 1: Bot feedback (staff rates bot answers → feed into learning)
CREATE TABLE IF NOT EXISTS bot_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  message_id TEXT,
  user_question TEXT NOT NULL,
  bot_answer TEXT NOT NULL,
  rating INTEGER,
  corrected_answer TEXT,
  reviewed_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_hotel ON bot_feedback(hotel_id, created_at DESC);

-- v2 Phase 1: Monthly cross-hotel learning patterns (anonymized)
CREATE TABLE IF NOT EXISTS monthly_learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  accuracy REAL DEFAULT 0,
  hotels_learned_from INTEGER DEFAULT 0,
  applied_to_hotels INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_month ON monthly_learnings(month);
`);

// ═══════════════════════════════════════════════════════════
// v13 Feedback Loop — Bot self-evolution infrastructure
// Mục đích: log mọi reply + outcome → bot biết đúng/sai để tự tune
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Mỗi reply của bot = 1 row; outcome ban đầu = 'pending', classifier update sau
CREATE TABLE IF NOT EXISTS bot_reply_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  conversation_memory_id INTEGER,       -- link tới row trong conversation_memory (bot reply)
  user_message TEXT,                    -- câu hỏi gốc của khách
  bot_reply TEXT NOT NULL,              -- câu trả lời bot đã gửi
  intent TEXT,                          -- intent được classifier detect
  stage TEXT,                           -- FSM stage khi reply
  reply_source TEXT,                    -- 'generic_*', 'rag_*', 'hotel_overview', 'funnel_*', 'contact_captured'
  rag_chunks_used TEXT,                 -- JSON array: chunk_ids + scores (nếu dùng RAG)
  llm_provider TEXT,                    -- 'gemini' | 'ollama' | 'groq'
  llm_model TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  outcome TEXT DEFAULT 'pending',
    -- pending | ignored | followup_same_topic | misunderstood | handed_off
    -- | converted_to_lead | booked | closed_won | ghosted | rage_quit
  outcome_at INTEGER,                   -- timestamp khi outcome được classify
  outcome_evidence TEXT,                -- JSON: cái gì làm classifier quyết định (vd: next_msg, delay)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_hotel_created ON bot_reply_outcomes(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_sender ON bot_reply_outcomes(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_pending ON bot_reply_outcomes(outcome, created_at) WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS idx_outcomes_source ON bot_reply_outcomes(reply_source, outcome);

-- Log mọi chuyển stage của FSM → phân tích drop-off funnel
CREATE TABLE IF NOT EXISTS funnel_stage_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  from_stage TEXT,                      -- NULL nếu là INIT (turn đầu)
  to_stage TEXT NOT NULL,
  trigger_intent TEXT,                  -- intent làm stage chuyển
  trigger_msg TEXT,                     -- message của user (truncate 200)
  slots_snapshot TEXT,                  -- JSON: slots lúc chuyển stage
  same_stage_count INTEGER DEFAULT 0,   -- nếu >0 nghĩa là stuck ở stage cũ
  transition_type TEXT,                 -- 'forward' | 'backward' | 'same' | 'reset' | 'handoff'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_hotel_created ON funnel_stage_transitions(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transitions_sender ON funnel_stage_transitions(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transitions_stage ON funnel_stage_transitions(from_stage, to_stage);

-- Daily aggregation — sẵn sàng cho dashboard, update bởi cron
CREATE TABLE IF NOT EXISTS funnel_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  date TEXT NOT NULL,                   -- 'YYYY-MM-DD' VN time
  stage TEXT NOT NULL,
  entered_count INTEGER DEFAULT 0,       -- số conversations vào stage
  exited_forward INTEGER DEFAULT 0,      -- vào stage tiếp theo
  exited_dropoff INTEGER DEFAULT 0,      -- không trả lời / bỏ dở
  exited_handoff INTEGER DEFAULT 0,      -- chuyển human
  avg_time_in_stage_sec INTEGER DEFAULT 0,
  UNIQUE(hotel_id, date, stage)
);
CREATE INDEX IF NOT EXISTS idx_funnel_daily ON funnel_daily_metrics(hotel_id, date DESC);

-- Human review labels (admin flag replies tốt/xấu cho supervised learning)
CREATE TABLE IF NOT EXISTS conversation_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  outcome_id INTEGER,                   -- link bot_reply_outcomes.id
  label TEXT NOT NULL,                  -- 'good', 'bad', 'wrong_info', 'off_topic', 'needs_rewrite'
  corrected_reply TEXT,                 -- admin viết lại cho đúng
  notes TEXT,
  labeled_by INTEGER,                   -- mkt_users.id
  created_at INTEGER NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES bot_reply_outcomes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_labels_hotel ON conversation_labels(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labels_outcome ON conversation_labels(outcome_id);
`);

// ═══════════════════════════════════════════════════════════
// v15 Domain Data — bot trả lời giá động + chính sách + promo
// hotel_policy_rules: cancellation, VIP discount, early-checkin, late-checkout, pet, smoking
// pricing_rules: weekend markup, long-stay discount, early-bird, last-minute, seasonal
// promotions: active promo codes (SONDER2026, BIRTHDAY, ...)
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Policy rules (detailed, nhiều rules/hotel)
CREATE TABLE IF NOT EXISTS hotel_policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,            -- 0 = global apply all hotels
  policy_type TEXT NOT NULL,            -- 'cancellation' | 'early_checkin' | 'late_checkout' | 'vip_discount' | 'pet' | 'smoking' | 'child' | 'damage' | 'payment'
  rule_name TEXT NOT NULL,              -- 'free_48h_cancel', 'vip_tier_regular', ...
  conditions_json TEXT,                 -- {"hours_before_checkin": 48} | {"customer_tier": "vip"} | {"pet_type": "small_dog"}
  effect_json TEXT,                     -- {"refund_percent": 100} | {"discount_percent": 10} | {"allowed": true, "surcharge_vnd": 200000}
  description TEXT,                     -- nội dung bot đọc khi trả lời khách
  priority INTEGER DEFAULT 0,           -- higher = applied first (when multiple match)
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_rules_hotel_type ON hotel_policy_rules(hotel_id, policy_type, active);

-- Pricing rules (dynamic price calculator)
CREATE TABLE IF NOT EXISTS pricing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,            -- 0 = global
  room_type_code TEXT,                  -- NULL = apply all room types
  rule_type TEXT NOT NULL,              -- 'weekend_markup' | 'long_stay' | 'early_bird' | 'last_minute' | 'seasonal' | 'group'
  rule_name TEXT NOT NULL,              -- 'weekend_fri_sat', 'long_7plus_nights', ...
  conditions_json TEXT,                 -- {"days_of_week": [5,6]} | {"nights_min": 7} | {"days_ahead_max": 3} | {"date_from": "2026-04-30", "date_to": "2026-05-02"}
  modifier_type TEXT NOT NULL,          -- 'percent_add' | 'percent_discount' | 'fixed_add' | 'fixed_discount'
  modifier_value REAL NOT NULL,
  priority INTEGER DEFAULT 0,           -- higher applied first
  stackable INTEGER DEFAULT 1,          -- 0 = exclusive with other rules
  description TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_hotel_type ON pricing_rules(hotel_id, rule_type, active);

-- Promotions (active codes)
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,  -- 0 = global
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL,          -- 'percent' | 'fixed_vnd'
  discount_value REAL NOT NULL,
  max_discount_vnd INTEGER,             -- cap nếu percent
  min_order_vnd INTEGER,
  eligibility_json TEXT,                -- {"first_time_only": true, "customer_tier": ["new", "regular"]}
  usage_limit INTEGER,                  -- total (NULL = unlimited)
  usage_per_customer INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  valid_from INTEGER,
  valid_to INTEGER,
  active INTEGER DEFAULT 1,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotions_code ON promotions(code, active);
CREATE INDEX IF NOT EXISTS idx_promotions_valid ON promotions(active, valid_from, valid_to);

-- Track promo usage (anti-abuse + analytics)
CREATE TABLE IF NOT EXISTS promotion_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id INTEGER NOT NULL,
  promotion_code TEXT NOT NULL,
  sender_id TEXT,
  booking_id INTEGER,
  customer_phone TEXT,
  discount_applied_vnd INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (promotion_id) REFERENCES promotions(id)
);
CREATE INDEX IF NOT EXISTS idx_promo_usage_sender ON promotion_usage(sender_id, promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_usage_booking ON promotion_usage(booking_id);
`);

// ═══════════════════════════════════════════════════════════
// v16 Marketing Audiences — segmentation + broadcast campaigns
// Flow: define audience → cron refresh members → admin create campaign →
//       send Zalo ZNS / FB → track delivery/open/click/conversion
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Audience definitions (segment rules)
CREATE TABLE IF NOT EXISTS marketing_audiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,    -- 0 = global
  audience_name TEXT NOT NULL,            -- 'vip_inactive_30d'
  display_name TEXT NOT NULL,             -- 'Khách VIP không hoạt động 30 ngày'
  description TEXT,
  filter_type TEXT NOT NULL,              -- 'sql_rule' | 'custom_fn' | 'manual'
  filter_criteria TEXT NOT NULL,          -- JSON: {tier:"vip", last_booking_days_gte:30}
  sql_query TEXT,                         -- For filter_type='sql_rule' (custom SELECT returning sender_id)
  refresh_interval_min INTEGER DEFAULT 1440,
  last_refreshed_at INTEGER,
  last_refresh_duration_ms INTEGER,
  member_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(hotel_id, audience_name)
);
CREATE INDEX IF NOT EXISTS idx_audiences_active ON marketing_audiences(active, hotel_id);

-- Memberships (who's in which audience)
CREATE TABLE IF NOT EXISTS audience_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience_id INTEGER NOT NULL,
  sender_id TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  hotel_id INTEGER,
  metadata TEXT,                          -- JSON {last_booking_at, ltv_vnd, bookings_count, ...}
  added_at INTEGER NOT NULL,
  FOREIGN KEY (audience_id) REFERENCES marketing_audiences(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_unique ON audience_memberships(audience_id, sender_id, customer_phone);
CREATE INDEX IF NOT EXISTS idx_memberships_audience ON audience_memberships(audience_id);
CREATE INDEX IF NOT EXISTS idx_memberships_sender ON audience_memberships(sender_id);

-- Broadcast campaigns
CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  audience_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,                  -- 'zalo_zns' | 'fb_message' | 'email' | 'sms'
  template_id TEXT,                       -- Zalo ZNS template_id hoặc FB message template
  template_params TEXT,                   -- JSON variables cho template
  message_content TEXT,                   -- Raw message cho FB/email (ZNS dùng template)
  status TEXT DEFAULT 'draft',            -- 'draft'|'scheduled'|'sending'|'sent'|'failed'|'cancelled'
  scheduled_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  target_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  converted_count INTEGER DEFAULT 0,
  error_summary TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (audience_id) REFERENCES marketing_audiences(id)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON broadcast_campaigns(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_audience ON broadcast_campaigns(audience_id);

-- Per-recipient send tracking
CREATE TABLE IF NOT EXISTS broadcast_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  sender_id TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  channel TEXT,
  status TEXT DEFAULT 'queued',           -- 'queued'|'sent'|'delivered'|'opened'|'clicked'|'converted'|'failed'|'blocked'
  provider_msg_id TEXT,                   -- Zalo ZNS tracking_id
  sent_at INTEGER,
  delivered_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  converted_at INTEGER,
  converted_booking_id INTEGER,
  error TEXT,
  FOREIGN KEY (campaign_id) REFERENCES broadcast_campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sends_campaign ON broadcast_sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_sender ON broadcast_sends(sender_id);
`);

// ═══════════════════════════════════════════════════════════
// v17 Self-Improvement Engine
// - reply_templates: variant pool cho mỗi touchpoint (greeting, show_results, closing, ...)
// - reply_experiments: A/B test config (which variants compete)
// - reply_assignments: deterministic hash(sender×experiment) → variant
// - prompt_lessons: supervised signals từ conversation_labels (do/don't injections)
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Template pool — mỗi row = 1 variant cho 1 touchpoint
CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,          -- 0 = global
  template_key TEXT NOT NULL,                    -- 'greeting_new' | 'show_results_empty' | 'show_results_list' | 'closing_ask_phone'
  variant_name TEXT NOT NULL,                    -- 'A' | 'B' | 'C'
  content TEXT NOT NULL,                         -- Template text with {{vars}} placeholders
  vars_schema TEXT,                              -- JSON {vars: ['user_name', 'hotel_name']} — hint
  weight INTEGER DEFAULT 100,                    -- Traffic split (higher = more traffic)
  active INTEGER DEFAULT 1,
  is_winner INTEGER DEFAULT 0,                   -- 1 = promoted winner after A/B test
  impressions INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  misunderstood INTEGER DEFAULT 0,
  ghosted INTEGER DEFAULT 0,
  converted_to_lead INTEGER DEFAULT 0,
  booked INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(hotel_id, template_key, variant_name)
);
CREATE INDEX IF NOT EXISTS idx_tmpl_key_active ON reply_templates(template_key, active, weight);

-- A/B experiment config
CREATE TABLE IF NOT EXISTS reply_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,
  experiment_name TEXT NOT NULL,
  template_key TEXT NOT NULL,
  status TEXT DEFAULT 'running',                 -- 'running' | 'winner_selected' | 'stopped'
  min_sample_size INTEGER DEFAULT 50,
  winner_variant_id INTEGER,
  winner_conversion_rate REAL,
  winner_selected_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  notes TEXT,
  UNIQUE(hotel_id, template_key, experiment_name)
);
CREATE INDEX IF NOT EXISTS idx_exp_status ON reply_experiments(status, template_key);

-- Assignments (sender × experiment → variant) cho consistency cross-session
CREATE TABLE IF NOT EXISTS reply_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  experiment_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL,
  assigned_at INTEGER NOT NULL,
  UNIQUE(sender_id, experiment_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_sender ON reply_assignments(sender_id);
CREATE INDEX IF NOT EXISTS idx_assign_variant ON reply_assignments(variant_id);

-- Supervised lessons extracted từ conversation_labels (admin review từ v13)
CREATE TABLE IF NOT EXISTS prompt_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,
  lesson_type TEXT NOT NULL,                     -- 'avoid' | 'prefer' | 'tone' | 'fact_correction'
  context TEXT,                                  -- 'greeting' | 'cancellation' | 'any'
  description TEXT NOT NULL,                     -- natural language lesson
  example_bad TEXT,                              -- bot reply that was labeled 'bad'
  example_good TEXT,                             -- admin-provided correction
  source_outcome_id INTEGER,                     -- link bot_reply_outcomes
  source_label_id INTEGER,                       -- link conversation_labels
  injected_count INTEGER DEFAULT 0,              -- how many times injected into prompts
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_context ON prompt_lessons(context, active, lesson_type);
`);

// ═══════════════════════════════════════════════════════════
// v18 Proactive Outreach — bot tự chủ động nhắn khách
// Triggers: pre_checkin_1d, post_checkout_3d, birthday_month,
//           abandoned_cart_2h, funnel_stuck_24h, vip_winback_30d
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Queue + history of proactive outreach attempts
CREATE TABLE IF NOT EXISTS scheduled_outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,                    -- 'pre_checkin_1d' | 'post_checkout_3d' | 'birthday_month' | 'abandoned_cart' | 'funnel_stuck' | 'vip_winback'
  sender_id TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  channel TEXT NOT NULL,                         -- 'zalo_message' | 'zalo_zns' | 'fb_message' | 'telegram'
  template_key TEXT,                             -- Reference reply_templates (optional)
  message_content TEXT,                          -- Final rendered message
  context_json TEXT,                             -- JSON: {booking_id, checkin_date, promo_code, ...}
  status TEXT DEFAULT 'queued',                  -- 'queued' | 'sent' | 'delivered' | 'replied' | 'converted' | 'failed' | 'skipped'
  scheduled_at INTEGER NOT NULL,                 -- When to send
  sent_at INTEGER,
  replied_at INTEGER,
  converted_at INTEGER,
  converted_booking_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(hotel_id, sender_id, trigger_type, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_outreach_queue ON scheduled_outreach(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_outreach_sender ON scheduled_outreach(sender_id, trigger_type);
CREATE INDEX IF NOT EXISTS idx_outreach_status_sent ON scheduled_outreach(status, sent_at DESC);

-- Rate limit guard: tối đa N outreach/sender/day (chống spam)
CREATE TABLE IF NOT EXISTS outreach_rate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  date_str TEXT NOT NULL,                        -- 'YYYY-MM-DD' VN time
  sent_count INTEGER DEFAULT 1,
  UNIQUE(sender_id, date_str)
);
`);

// ═══════════════════════════════════════════════════════════
// v19 Revenue Attribution — track $ tied to every touchpoint
// revenue_events: every booking/promo/upsell as $ event
// attribution_links: booking × (reply_source, variant, audience, campaign, outreach, promo)
// customer_ltv: cached LTV per customer
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Every $ event (booking confirmed/paid, promo applied, upsell)
CREATE TABLE IF NOT EXISTS revenue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,                      -- 'booking_confirmed' | 'promo_applied' | 'upsell' | 'refund'
  booking_id INTEGER,
  sender_id TEXT,
  customer_phone TEXT,
  amount_vnd INTEGER NOT NULL,                   -- Positive = revenue, Negative = refund
  margin_vnd INTEGER,                            -- Estimated profit (after cost)
  currency TEXT DEFAULT 'VND',
  notes TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_booking ON revenue_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_rev_sender ON revenue_events(sender_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_occurred ON revenue_events(occurred_at DESC);

-- Link each booking to the touches that contributed (multi-touch attribution)
CREATE TABLE IF NOT EXISTS attribution_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  sender_id TEXT,
  touch_type TEXT NOT NULL,                      -- 'reply_source' | 'variant' | 'audience' | 'campaign' | 'outreach' | 'promo'
  touch_id TEXT NOT NULL,                        -- reply_source key | variant_id | audience_id | campaign_id | outreach_id | promo_code
  touch_value TEXT,                              -- Display name (variant_name, audience_name, etc.)
  weight REAL DEFAULT 1.0,                       -- Attribution weight (first-touch=1, linear = 1/N, etc.)
  attribution_model TEXT DEFAULT 'linear',       -- 'first_touch' | 'last_touch' | 'linear' | 'time_decay'
  touched_at INTEGER,                            -- When touch happened
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_booking ON attribution_links(booking_id);
CREATE INDEX IF NOT EXISTS idx_attr_touch_type_id ON attribution_links(touch_type, touch_id);
CREATE INDEX IF NOT EXISTS idx_attr_sender ON attribution_links(sender_id);

-- Cached LTV per customer (refreshed when new booking)
CREATE TABLE IF NOT EXISTS customer_ltv (
  sender_id TEXT PRIMARY KEY,
  customer_phone TEXT,
  customer_name TEXT,
  hotel_id INTEGER,
  total_bookings INTEGER DEFAULT 0,
  confirmed_bookings INTEGER DEFAULT 0,
  total_revenue_vnd INTEGER DEFAULT 0,
  avg_order_value_vnd INTEGER DEFAULT 0,
  first_booking_at INTEGER,
  last_booking_at INTEGER,
  predicted_ltv_vnd INTEGER DEFAULT 0,           -- Simple model: total × retention multiplier
  customer_tier TEXT DEFAULT 'new',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ltv_phone ON customer_ltv(customer_phone);
CREATE INDEX IF NOT EXISTS idx_ltv_total ON customer_ltv(total_revenue_vnd DESC);
`);

// ═══════════════════════════════════════════════════════════
// v21 Multi-platform Publishing
// instagram_accounts: IG Business linked with FB Page (access_token reuse)
// page_crosspost_links: FB Page → FB Page crosspost rules
// share_packages: content package push to Telegram cho admin manual share
// ═══════════════════════════════════════════════════════════
db.exec(`
-- Instagram Business accounts per hotel
CREATE TABLE IF NOT EXISTS instagram_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  ig_business_id TEXT NOT NULL UNIQUE,        -- Instagram Business Account ID
  ig_username TEXT,
  linked_fb_page_id INTEGER,                  -- pages.id — reuse access_token
  access_token TEXT,                          -- override nếu có token riêng
  active INTEGER DEFAULT 1,
  last_published_at INTEGER,
  total_posts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (linked_fb_page_id) REFERENCES pages(id)
);
CREATE INDEX IF NOT EXISTS idx_ig_hotel ON instagram_accounts(hotel_id, active);

-- FB Page → Page crosspost configuration
CREATE TABLE IF NOT EXISTS page_crosspost_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id INTEGER NOT NULL,            -- Primary page (source of truth)
  target_page_id INTEGER NOT NULL,            -- Also publish here
  delay_minutes INTEGER DEFAULT 20,           -- v22: 20 min default (safer ToS)
  modify_caption TEXT,                        -- Optional: prefix/suffix modification
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(source_page_id, target_page_id),
  FOREIGN KEY (source_page_id) REFERENCES pages(id),
  FOREIGN KEY (target_page_id) REFERENCES pages(id)
);
CREATE INDEX IF NOT EXISTS idx_xpost_source ON page_crosspost_links(source_page_id, active);

-- Share packages — bot gen content → admin manual share vào groups
CREATE TABLE IF NOT EXISTS share_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  source_post_id INTEGER,                     -- posts.id hoặc news_post_drafts.id
  source_type TEXT,                           -- 'fb_post' | 'ci_remix' | 'news_draft' | 'manual'
  caption TEXT NOT NULL,
  image_url TEXT,                             -- Direct link hoặc /media/ path
  hashtags TEXT,                              -- JSON array
  suggested_groups TEXT,                      -- JSON: [{name, url, category}]
  shared_to_groups TEXT,                      -- JSON: admin đã share vào group nào
  status TEXT DEFAULT 'pending',              -- 'pending' | 'shared' | 'dismissed'
  pushed_to_telegram_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_status ON share_packages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_hotel ON share_packages(hotel_id, created_at DESC);

-- Suggested FB groups database (admin manually curate)
CREATE TABLE IF NOT EXISTS suggested_fb_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  url TEXT,
  category TEXT,                              -- 'hotel_enthusiasts' | 'du_lich' | 'digital_nomad' | 'homestay_vn' | 'business_travel'
  member_count INTEGER,
  notes TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sug_groups_cat ON suggested_fb_groups(active, category);

-- v22: Dead Letter Queue cho posts fail quá 3 lần
CREATE TABLE IF NOT EXISTS failed_posts_dlq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,                    -- 'post' | 'news_draft' | 'remix_draft' | 'ig_publish' | 'crosspost'
  source_id INTEGER NOT NULL,                   -- Reference row id
  hotel_id INTEGER,
  page_id INTEGER,
  caption TEXT,
  image_url TEXT,
  last_error TEXT,
  retry_count INTEGER DEFAULT 3,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  moved_to_dlq_at INTEGER NOT NULL,
  admin_notified INTEGER DEFAULT 0,
  admin_notified_at INTEGER,
  resolved INTEGER DEFAULT 0,
  resolved_at INTEGER,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_dlq_source ON failed_posts_dlq(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_dlq_resolved ON failed_posts_dlq(resolved, moved_to_dlq_at DESC);
`);

// ═══════════════════════════════════════════════════════════
// v14 Sync Hub — Event broker giữa OTA Web team & VP MKT Bot
// Mục đích: OTA push availability updates + Bot push bookings → PMS
// HMAC-signed, audit logged, rate limited.
// ═══════════════════════════════════════════════════════════
db.exec(`
-- API keys cho các team gọi sync hub
CREATE TABLE IF NOT EXISTS sync_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT UNIQUE NOT NULL,          -- 'ota-web-prod', 'bot-internal'
  secret TEXT NOT NULL,                 -- HMAC SHA256 secret (64 chars)
  team_name TEXT NOT NULL,
  permissions TEXT NOT NULL,            -- JSON array: ['write_availability', 'read_bookings']
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  request_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_keys_active ON sync_api_keys(active, key_id);

-- Availability layer: room_type × date
CREATE TABLE IF NOT EXISTS sync_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_type_code TEXT NOT NULL,         -- match hotel_room_catalog.room_key
  date_str TEXT NOT NULL,               -- 'YYYY-MM-DD' VN timezone
  total_rooms INTEGER NOT NULL DEFAULT 0,
  available_rooms INTEGER NOT NULL DEFAULT 0,
  base_price INTEGER,                   -- VND per night
  stop_sell INTEGER DEFAULT 0,          -- manual block
  source TEXT DEFAULT 'ota',            -- 'ota' | 'bot' | 'manual' | 'seed'
  updated_at INTEGER NOT NULL,
  UNIQUE(hotel_id, room_type_code, date_str)
);
CREATE INDEX IF NOT EXISTS idx_sync_avail_hotel_date ON sync_availability(hotel_id, date_str);
CREATE INDEX IF NOT EXISTS idx_sync_avail_date ON sync_availability(date_str, available_rooms);
CREATE INDEX IF NOT EXISTS idx_sync_avail_updated ON sync_availability(updated_at);

-- Booking shared layer: bot + OTA + PMS cùng dùng
CREATE TABLE IF NOT EXISTS sync_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  source TEXT NOT NULL,                 -- 'bot' | 'ota' | 'walk_in'
  source_ref TEXT,                      -- internal ID của source system
  pms_booking_id TEXT,                  -- set bởi OTA team khi đã note PMS
  room_type_code TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  checkout_date TEXT NOT NULL,
  nights INTEGER NOT NULL DEFAULT 1,
  guests INTEGER DEFAULT 2,
  total_price INTEGER,
  deposit_amount INTEGER,
  deposit_paid INTEGER DEFAULT 0,
  deposit_proof_url TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  status TEXT DEFAULT 'hold',           -- 'hold'(15min) | 'confirmed' | 'synced' | 'cancelled' | 'checked_in' | 'no_show'
  expires_at INTEGER,                   -- cho status='hold'
  synced_to_pms_at INTEGER,
  sender_id TEXT,
  created_by TEXT,                      -- 'bot' | 'admin' | 'ota_import'
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_bookings_hotel_date ON sync_bookings(hotel_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_sync_bookings_status ON sync_bookings(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_bookings_pending_pms ON sync_bookings(status, synced_to_pms_at);
CREATE INDEX IF NOT EXISTS idx_sync_bookings_expires ON sync_bookings(status, expires_at);

-- Audit log (moi request in/out)
CREATE TABLE IF NOT EXISTS sync_events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,             -- 'availability_push' | 'booking_hold' | 'booking_confirm' | 'pms_sync_done'
  direction TEXT,                       -- 'inbound' | 'outbound'
  actor TEXT,                           -- key_id của API key hoặc 'bot_internal'
  hotel_id INTEGER,
  payload_json TEXT,
  hmac_verified INTEGER,
  http_status INTEGER,
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_events_type ON sync_events_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_actor ON sync_events_log(actor, created_at DESC);
`);

// 1.1 Migration: thêm hotel_id vào các bảng hiện tại (safe — chỉ ADD COLUMN nếu chưa có)
function safeAddColumn(table: string, column: string, type: string, defaultVal?: string) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.find(c => c.name === column)) {
      const def = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${def}`);
      console.log(`[db] Added ${table}.${column}`);
    }
  } catch (e) {
    console.error(`[db] migrate ${table}.${column} failed:`, e);
  }
}

// Thêm hotel_id vào tất cả bảng MKT hiện tại
safeAddColumn('pages', 'hotel_id', 'INTEGER', '1');
safeAddColumn('posts', 'hotel_id', 'INTEGER', '1');
safeAddColumn('campaigns', 'hotel_id', 'INTEGER', '1');
safeAddColumn('media', 'hotel_id', 'INTEGER', '1');
safeAddColumn('auto_reply_log', 'hotel_id', 'INTEGER', '1');
safeAddColumn('knowledge_wiki', 'hotel_id', 'INTEGER', '1');
safeAddColumn('ai_usage_log', 'hotel_id', 'INTEGER', '1');
safeAddColumn('ab_experiments', 'hotel_id', 'INTEGER', '1');
safeAddColumn('pending_bookings', 'hotel_id', 'INTEGER', '1');
safeAddColumn('telegram_chats', 'hotel_id', 'INTEGER', '1');
safeAddColumn('settings', 'hotel_id', 'INTEGER', '1');

// v2 Phase 1: SaaS subscription tracking
safeAddColumn('mkt_hotels', 'plan_expires_at', 'INTEGER');
safeAddColumn('mkt_hotels', 'trial_ends_at', 'INTEGER');
safeAddColumn('mkt_hotels', 'onboarding_step', 'TEXT', `'pending'`);
safeAddColumn('subscription_requests', 'proof_url', 'TEXT');
safeAddColumn('subscription_requests', 'amount', 'INTEGER');
safeAddColumn('subscription_requests', 'admin_note', 'TEXT');
safeAddColumn('subscription_requests', 'reviewed_by', 'INTEGER');
safeAddColumn('subscription_requests', 'reviewed_at', 'INTEGER');
safeAddColumn('subscription_requests', 'ref_code', 'TEXT');

// Kill switch: KS tạm tắt bot cho hotel
safeAddColumn('mkt_hotels', 'bot_paused_until', 'INTEGER');
safeAddColumn('mkt_hotels', 'bot_pause_reason', 'TEXT');

// Self-signup (standalone users, không qua OTA DB)
safeAddColumn('mkt_users', 'password_hash', 'TEXT');
safeAddColumn('mkt_users', 'phone', 'TEXT');
safeAddColumn('mkt_users', 'signup_source', 'TEXT');   // 'self' | 'ota' | 'invite' | 'fb_oauth'
safeAddColumn('mkt_hotels', 'industry', 'TEXT', `'hotel'`);
safeAddColumn('mkt_hotels', 'website_url', 'TEXT');
// v7: link marketing hotel tenant to OTA hotel in knowledge base
safeAddColumn('mkt_hotels', 'ota_hotel_id', 'INTEGER');

// v6 Sprint 3: Memory recall — embed user messages for semantic search
safeAddColumn('conversation_memory', 'embedding', 'BLOB');

// v7.1: property_type (apartment | homestay | hotel | resort | villa | guesthouse)
safeAddColumn('hotel_profile', 'property_type', 'TEXT');
// v7.2: rental_type (per_night | per_hour | per_month | mixed)
safeAddColumn('hotel_profile', 'rental_type', 'TEXT', `'per_night'`);

// v7.3: Sonder Business structure
safeAddColumn('hotel_profile', 'product_group', 'TEXT'); // 'short_stay' | 'long_term_apartment'
safeAddColumn('hotel_profile', 'scraped_data', 'TEXT');  // JSON blob for extra SSR fields
// Apartment-specific fields
safeAddColumn('hotel_profile', 'monthly_price_from', 'INTEGER');
safeAddColumn('hotel_profile', 'monthly_price_to', 'INTEGER');
safeAddColumn('hotel_profile', 'min_stay_months', 'INTEGER');
safeAddColumn('hotel_profile', 'deposit_months', 'INTEGER');
safeAddColumn('hotel_profile', 'utilities_included', 'INTEGER');
safeAddColumn('hotel_profile', 'full_kitchen', 'INTEGER');
safeAddColumn('hotel_profile', 'washing_machine', 'INTEGER');
// Scraper freshness tracking
safeAddColumn('hotel_profile', 'scraped_at', 'INTEGER');
safeAddColumn('hotel_profile', 'data_source', 'TEXT'); // 'scraper' | 'api' | 'manual'

// v8: Smart Intent Training Pipeline (Q&A cache + human review + feedback loop)
db.exec(`
CREATE TABLE IF NOT EXISTS qa_training_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,

  -- Input
  customer_question TEXT NOT NULL,
  question_embedding BLOB,
  question_hash TEXT,

  -- Output
  ai_response TEXT NOT NULL,
  ai_provider TEXT NOT NULL,
  ai_model TEXT,
  ai_tokens_used INTEGER DEFAULT 0,

  -- Lifecycle
  tier TEXT NOT NULL DEFAULT 'pending',
  admin_notes TEXT,
  admin_edited_response TEXT,
  admin_user_id INTEGER,
  approved_at INTEGER,

  -- Metrics
  hits_count INTEGER DEFAULT 0,
  positive_feedback INTEGER DEFAULT 0,
  negative_feedback INTEGER DEFAULT 0,
  feedback_score REAL DEFAULT 0,

  -- Context
  intent_category TEXT,
  context_tags TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER,
  last_reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qa_hotel_tier ON qa_training_cache(hotel_id, tier);
CREATE INDEX IF NOT EXISTS idx_qa_hash ON qa_training_cache(question_hash);
CREATE INDEX IF NOT EXISTS idx_qa_feedback ON qa_training_cache(feedback_score DESC);
CREATE INDEX IF NOT EXISTS idx_qa_last_hit ON qa_training_cache(last_hit_at DESC);

CREATE TABLE IF NOT EXISTS qa_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qa_cache_id INTEGER NOT NULL,
  customer_id TEXT,
  sentiment TEXT,
  signal TEXT,
  follow_up_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (qa_cache_id) REFERENCES qa_training_cache(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qa_fb_cache ON qa_feedback(qa_cache_id);
CREATE INDEX IF NOT EXISTS idx_qa_fb_created ON qa_feedback(created_at DESC);

-- v9 News Pipeline: ingest RSS → classify → angle → Sonder spin → admin review → publish
CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source TEXT NOT NULL,
  source_tier TEXT,                    -- 'AAA' | 'AA' | 'A' (credibility)
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  lang TEXT DEFAULT 'vi',
  -- Classification (Phase N-2)
  is_travel_relevant INTEGER DEFAULT 0,
  relevance_score REAL DEFAULT 0,
  impact_score REAL DEFAULT 0,
  political_risk REAL DEFAULT 0,
  region TEXT,
  angle_hint TEXT,
  title_embedding BLOB,                -- cho dedupe similarity (Phase N-2)
  -- State machine
  status TEXT DEFAULT 'ingested',
    -- ingested | filtered_out | angle_generated | safety_failed
    -- | pending_review | approved | rejected | published
  status_note TEXT,
  created_at INTEGER NOT NULL,
  last_state_change_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_url_hash ON news_articles(url_hash);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_status ON news_articles(status);
CREATE INDEX IF NOT EXISTS idx_news_source ON news_articles(source);

CREATE TABLE IF NOT EXISTS news_post_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  hotel_id INTEGER NOT NULL,
  page_id INTEGER,
  draft_angle TEXT NOT NULL,            -- từ Gemini
  draft_post TEXT NOT NULL,             -- sau Sonder spin
  edited_post TEXT,                     -- admin edit
  image_url TEXT,
  hashtags TEXT,                        -- JSON array
  -- Safety (Phase N-4)
  safety_flags TEXT,                    -- JSON {keyword_hits, tone, criticism, offensive, fact_source}
  auto_rejected INTEGER DEFAULT 0,
  rejection_reason TEXT,
  -- Publish
  status TEXT DEFAULT 'pending',
    -- pending | approved | rejected | published | failed
  scheduled_at INTEGER,
  published_at INTEGER,
  fb_post_id TEXT,
  admin_user_id INTEGER,
  admin_notes TEXT,
  ai_provider TEXT,                     -- provider đã sinh angle
  ai_tokens_used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (article_id) REFERENCES news_articles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_news_drafts_status_hotel ON news_post_drafts(status, hotel_id);
CREATE INDEX IF NOT EXISTS idx_news_drafts_scheduled ON news_post_drafts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_news_drafts_article ON news_post_drafts(article_id);

-- v12 Content Intelligence: phân tích bài cạnh tranh + remix thành Sonder voice
CREATE TABLE IF NOT EXISTS inspiration_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 1,
  source_name TEXT,                       -- "Vinpearl Official FB", "Booking.com", ...
  source_url TEXT,                         -- URL bài viết gốc (nếu có)
  source_type TEXT DEFAULT 'facebook',     -- facebook | instagram | tiktok | blog | other
  original_text TEXT NOT NULL,             -- Nội dung bài gốc (admin paste)
  language TEXT DEFAULT 'vi',
  -- Engagement metrics (nếu admin nhập / auto scrape)
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement_rate REAL DEFAULT 0,          -- calculated
  -- AI analysis
  pattern_hook TEXT,                       -- curiosity_question | number_shock | story | ...
  pattern_emotion TEXT,                    -- excitement | nostalgia | urgency | fomo | ...
  pattern_structure TEXT,                  -- problem-solution | listicle | story-arc | ...
  pattern_cta TEXT,                        -- soft_inquiry | direct_book | share | ...
  topic_tags TEXT,                         -- JSON array
  ai_insights TEXT,                        -- AI explain vì sao bài này hiệu quả
  remix_angle_suggestions TEXT,            -- JSON array — các góc admin có thể remix
  admin_notes TEXT,
  status TEXT DEFAULT 'analyzed',          -- pending | analyzed | archived
  created_at INTEGER NOT NULL,
  analyzed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inspiration_hotel ON inspiration_posts(hotel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remix_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspiration_id INTEGER,                  -- source inspiration
  hotel_id INTEGER NOT NULL,
  remix_angle TEXT,                        -- admin chọn angle nào
  remix_text TEXT NOT NULL,
  brand_voice TEXT DEFAULT 'friendly',
  hashtags TEXT,                           -- JSON array
  ai_provider TEXT,
  ai_tokens_used INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',             -- draft | approved | published | discarded
  scheduled_at INTEGER,
  published_at INTEGER,
  fb_post_id TEXT,
  admin_user_id INTEGER,
  admin_notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (inspiration_id) REFERENCES inspiration_posts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_remix_status ON remix_drafts(status, hotel_id);
`);

// v7: Hotel Knowledge Layer — AI-synthesized bot-ready data
db.exec(`
CREATE TABLE IF NOT EXISTS hotel_profile (
  hotel_id INTEGER PRIMARY KEY,
  ota_hotel_id INTEGER,
  name_canonical TEXT NOT NULL,
  name_en TEXT,
  city TEXT,
  district TEXT,
  address TEXT,
  latitude REAL,
  longitude REAL,
  geohash TEXT,
  phone TEXT,
  star_rating INTEGER,
  target_segment TEXT,
  brand_voice TEXT,
  ai_summary_vi TEXT,
  ai_summary_en TEXT,
  usp_top3 TEXT,
  nearby_landmarks TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  synthesized_at INTEGER,
  synthesized_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hp_geohash ON hotel_profile(geohash);
CREATE INDEX IF NOT EXISTS idx_hp_city ON hotel_profile(city);

CREATE TABLE IF NOT EXISTS hotel_room_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_key TEXT NOT NULL,
  display_name_vi TEXT NOT NULL,
  display_name_en TEXT,
  price_weekday INTEGER NOT NULL DEFAULT 0,
  price_weekend INTEGER NOT NULL DEFAULT 0,
  price_hourly INTEGER,
  max_guests INTEGER NOT NULL DEFAULT 2,
  bed_config TEXT,
  size_m2 INTEGER,
  amenities TEXT,
  photos_urls TEXT,
  description_vi TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(hotel_id, room_key)
);
CREATE INDEX IF NOT EXISTS idx_hrc_hotel ON hotel_room_catalog(hotel_id);

CREATE TABLE IF NOT EXISTS hotel_amenities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  name_vi TEXT NOT NULL,
  name_en TEXT,
  free INTEGER NOT NULL DEFAULT 1,
  hours TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ha_hotel ON hotel_amenities(hotel_id);

CREATE TABLE IF NOT EXISTS hotel_policies (
  hotel_id INTEGER PRIMARY KEY,
  checkin_time TEXT,
  checkout_time TEXT,
  cancellation_text TEXT,
  deposit_percent INTEGER,
  pet_allowed INTEGER NOT NULL DEFAULT 0,
  child_policy TEXT,
  payment_methods TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hotel_knowledge_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  chunk_type TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding BLOB,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hke_hotel ON hotel_knowledge_embeddings(hotel_id, chunk_type);

CREATE TABLE IF NOT EXISTS etl_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  hotels_total INTEGER DEFAULT 0,
  hotels_ok INTEGER DEFAULT 0,
  hotels_failed INTEGER DEFAULT 0,
  provider_gemini INTEGER DEFAULT 0,
  provider_fallback INTEGER DEFAULT 0,
  duration_ms INTEGER,
  trigger_source TEXT,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_esl_started ON etl_sync_log(started_at DESC);

CREATE TABLE IF NOT EXISTS etl_hotel_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_log_id INTEGER NOT NULL,
  ota_hotel_id INTEGER,
  hotel_name TEXT,
  reason TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

// ═══════════════════════════════════════════════════════════════════
// v10 Đợt 1: Unified Hotel Bot Context View
// ═══════════════════════════════════════════════════════════════════
// Gộp 4 knowledge sources (mkt_hotels + hotel_profile + room_catalog +
// amenities + policies) thành 1 view duy nhất cho bot query.
// Resolves hotel_id mismatch: mkt_hotels.id <-> hotel_profile.hotel_id
// (thực chất là ota_hotel_id) qua mkt_hotels.ota_hotel_id link.
//
// DROP + CREATE để luôn reflect schema mới nhất (view không có data).
db.exec(`
DROP VIEW IF EXISTS v_hotel_bot_context;
CREATE VIEW v_hotel_bot_context AS
SELECT
  -- Keys (bot có thể lookup bằng mkt.id hoặc ota_hotel_id)
  mh.id AS mkt_hotel_id,
  mh.ota_hotel_id,
  hp.hotel_id AS profile_hotel_id,
  -- Basic
  COALESCE(hp.name_canonical, mh.name) AS name,
  hp.name_en,
  mh.slug,
  mh.plan,
  mh.status AS hotel_status,
  -- Location
  hp.city, hp.district, hp.address,
  hp.latitude, hp.longitude, hp.geohash,
  hp.phone,
  hp.star_rating,
  -- Classification (Sonder: monthly_apartment vs nightly_stay)
  hp.property_type, hp.rental_type, hp.product_group, hp.target_segment,
  -- Brand voice (friendly | formal | luxury) — inject vào bot prompt
  COALESCE(hp.brand_voice, 'friendly') AS brand_voice,
  -- AI-synthesized content
  hp.ai_summary_vi, hp.ai_summary_en,
  hp.usp_top3, hp.nearby_landmarks,
  -- Apartment-specific (monthly rental)
  hp.monthly_price_from, hp.monthly_price_to,
  hp.min_stay_months, hp.deposit_months,
  hp.full_kitchen, hp.washing_machine, hp.utilities_included,
  -- Raw scraped blob (JSON) cho fallback parsing
  hp.scraped_data,
  hp.data_source, hp.synthesized_at, hp.scraped_at,
  -- Aggregated counts cho bot biết sẵn sàng bao nhiêu data
  (SELECT COUNT(*) FROM hotel_room_catalog WHERE hotel_id = hp.hotel_id) AS rooms_count,
  (SELECT COUNT(*) FROM hotel_amenities WHERE hotel_id = hp.hotel_id) AS amenities_count,
  CASE WHEN (SELECT 1 FROM hotel_policies WHERE hotel_id = hp.hotel_id) = 1 THEN 1 ELSE 0 END AS has_policies,
  -- Price hints (nightly)
  (SELECT MIN(price_weekday) FROM hotel_room_catalog
    WHERE hotel_id = hp.hotel_id AND price_weekday > 0) AS price_min_vnd,
  (SELECT MAX(price_weekday) FROM hotel_room_catalog
    WHERE hotel_id = hp.hotel_id AND price_weekday > 0) AS price_max_vnd,
  (SELECT MIN(price_hourly) FROM hotel_room_catalog
    WHERE hotel_id = hp.hotel_id AND price_hourly > 0) AS price_hourly_min_vnd
FROM mkt_hotels mh
LEFT JOIN hotel_profile hp ON hp.ota_hotel_id = mh.ota_hotel_id
WHERE mh.status != 'deleted';
`);

// View rooms: đơn giản + enriched
db.exec(`
DROP VIEW IF EXISTS v_hotel_rooms;
CREATE VIEW v_hotel_rooms AS
SELECT
  mh.id AS mkt_hotel_id,
  mh.ota_hotel_id,
  hrc.id, hrc.room_key,
  hrc.display_name_vi, hrc.display_name_en,
  hrc.price_weekday, hrc.price_weekend, hrc.price_hourly,
  hrc.max_guests, hrc.bed_config, hrc.size_m2,
  hrc.amenities, hrc.photos_urls, hrc.description_vi,
  hrc.updated_at
FROM hotel_room_catalog hrc
LEFT JOIN mkt_hotels mh ON mh.ota_hotel_id = hrc.hotel_id;
`);

// View amenities: grouped by category
db.exec(`
DROP VIEW IF EXISTS v_hotel_amenities;
CREATE VIEW v_hotel_amenities AS
SELECT
  mh.id AS mkt_hotel_id,
  mh.ota_hotel_id,
  ha.category, ha.name_vi, ha.name_en,
  ha.free, ha.hours, ha.note
FROM hotel_amenities ha
LEFT JOIN mkt_hotels mh ON mh.ota_hotel_id = ha.hotel_id;
`);

console.log('[db] Created unified bot views: v_hotel_bot_context + v_hotel_rooms + v_hotel_amenities');

// ═══════════════════════════════════════════════════════════
// v23 — intent_logs: log mọi message qua Gemini Intent Classifier
// Mục đích: analytics + training data cho tuning classifier + debug
// ═══════════════════════════════════════════════════════════
db.exec(`
CREATE TABLE IF NOT EXISTS intent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  channel TEXT,                         -- 'fb' | 'zalo' | 'web' | 'api'
  user_message TEXT NOT NULL,           -- tin gốc của khách (truncate 500)
  msg_length INTEGER,                   -- length cho analytics
  fsm_stage TEXT,                       -- FSM stage khi classify
  primary_intent TEXT,                  -- booking | info_question | greeting | ...
  sub_category TEXT,                    -- price | amenity | wifi | ...
  confidence REAL,                      -- 0-1
  in_knowledge_base INTEGER,            -- 1/0
  needs_clarification INTEGER,          -- 1/0
  is_faq_intent INTEGER,                -- 1/0 (v23)
  pause_slot_filling INTEGER,           -- 1/0 (v23)
  extracted_slots TEXT,                 -- JSON: slots detected
  classifier_provider TEXT,             -- 'gemini_flash' | 'ollama' | 'groq'
  classifier_latency_ms INTEGER,
  routed_to TEXT,                       -- route taken: 'rag' | 'funnel' | 'policy' | 'promo' | 'pricing' | 'generic' | ...
  reply_fingerprint TEXT,               -- first 30 chars of bot reply để trace duplicate
  greeting_gated INTEGER DEFAULT 0,     -- 1 nếu greeting bị gate skip
  error TEXT,                           -- nếu classifier fail
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_logs_hotel_created ON intent_logs(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_logs_sender ON intent_logs(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_logs_intent ON intent_logs(primary_intent, sub_category);
CREATE INDEX IF NOT EXISTS idx_intent_logs_route ON intent_logs(routed_to, created_at DESC);
`);
console.log('[db] intent_logs table ready (v23)');

// Indexes trên hotel_id
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_hotel ON pages(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_hotel ON posts(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_hotel ON campaigns(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autoreply_hotel ON auto_reply_log(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_hotel ON knowledge_wiki(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_hotel ON ai_usage_log(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_bk_hotel ON pending_bookings(hotel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_settings_hotel ON settings(hotel_id)`);
} catch (e) {
  console.error('[db] index creation:', e);
}

// 1.5 Migration: tạo hotel mặc định (Sonder) nếu chưa có
try {
  const defaultHotel = db.prepare(`SELECT id FROM mkt_hotels WHERE id = 1`).get();
  if (!defaultHotel) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO mkt_hotels (id, ota_hotel_id, name, slug, plan, status, config, features, max_posts_per_day, max_pages, activated_at, created_at, updated_at)
      VALUES (1, NULL, 'Sonder Vietnam', 'sonder', 'pro', 'active', '{}', '{"chatbot":true,"autopilot":true,"booking":true,"analytics":true,"ab_test":true}', 5, 5, ?, ?, ?)
    `).run(now, now, now);
    console.log('[db] Created default mkt_hotel: Sonder Vietnam (id=1)');
  }
} catch (e) {
  console.error('[db] default hotel creation:', e);
}

// Helpers
export function getSetting(key: string, hotelId?: number): string | null {
  // Try hotel-specific setting first, fallback to global
  if (hotelId) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ? AND hotel_id = ?').get(key, hotelId) as { value: string } | undefined;
    if (row) return row.value;
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string, hotelId: number = 1) {
  db.prepare(
    `INSERT INTO settings (key, value, hotel_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value, hotelId, Date.now());
}

// Hotel helpers
export function getMktHotel(hotelId: number) {
  return db.prepare(`SELECT * FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
}

export function getMktHotels() {
  return db.prepare(`SELECT * FROM mkt_hotels ORDER BY id`).all() as any[];
}

export function getMktUser(email: string) {
  return db.prepare(`SELECT u.*, h.name as hotel_name, h.plan, h.status as hotel_status FROM mkt_users u JOIN mkt_hotels h ON h.id = u.hotel_id WHERE u.email = ? AND u.status = 'active'`).get(email) as any;
}

export function getMktUsersByHotel(hotelId: number) {
  return db.prepare(`SELECT * FROM mkt_users WHERE hotel_id = ? AND status = 'active'`).all(hotelId) as any[];
}
