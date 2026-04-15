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
