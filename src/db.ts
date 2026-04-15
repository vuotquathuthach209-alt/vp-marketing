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
`);

// Helpers
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value, Date.now());
}
