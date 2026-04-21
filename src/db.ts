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
