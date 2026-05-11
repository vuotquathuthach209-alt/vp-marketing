/**
 * Unified inbox — pull FB Page comments (on posts) + Page-level reviews into one read-only view.
 *
 * Does NOT pull private Messenger messages (that requires `pages_messaging` scope + careful PII handling
 * AND Meta's own inbox is the source of truth for chat replies).
 *
 * Focus: PUBLIC engagement that admin should monitor:
 *   - Comments on Page posts (within last 30 days)
 *   - Tagged mentions
 *
 * Each item → sentiment + question detection → flag urgent → save → notify if needed.
 */

import axios from 'axios';
import { db } from '../../db';
import { classifySentiment } from './sentiment';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PageRow { id: number; fb_page_id: string; access_token: string; name: string; }

function getPages(): PageRow[] {
  return db.prepare(`SELECT id, fb_page_id, access_token, name FROM pages`).all() as PageRow[];
}

/** Fetch comments on recent Page posts. */
async function fetchPageComments(page: PageRow, sinceMs: number): Promise<any[]> {
  // Step 1: get recent published posts (last 30 days)
  let posts: any[] = [];
  try {
    const r = await axios.get(`${GRAPH}/${page.fb_page_id}/published_posts`, {
      params: {
        fields: 'id,message,created_time,comments.limit(50){id,from,message,created_time,parent}',
        access_token: page.access_token,
        since: Math.floor(sinceMs / 1000),
        limit: 25,
      },
      timeout: 30_000,
    });
    posts = r.data?.data || [];
  } catch (e: any) {
    console.warn(`[care-inbox] FB posts fetch ${page.name} fail:`, e?.response?.data?.error?.message || e?.message);
    return [];
  }

  const out: any[] = [];
  for (const post of posts) {
    const postId = post.id;
    const comments = post.comments?.data || [];
    for (const c of comments) {
      // Skip Page's own replies (Page replies to itself = admin already engaged)
      if (c.from?.id === page.fb_page_id) continue;
      out.push({
        source_id: c.id,
        parent_post_id: postId,
        author_id: c.from?.id || null,
        author_name: c.from?.name || null,
        text: c.message || '',
        created_time_ms: c.created_time ? new Date(c.created_time).getTime() : Date.now(),
        is_reply: !!c.parent,
      });
    }
  }
  return out;
}

/** Sync inbox: pull + classify + persist + alert. */
export async function syncInbox(opts?: { since_days?: number }): Promise<{
  pulled: number;
  new: number;
  classified: number;
  questions: number;
  needs_response: number;
  errors: number;
}> {
  const result = { pulled: 0, new: 0, classified: 0, questions: 0, needs_response: 0, errors: 0 };
  const sinceMs = Date.now() - (opts?.since_days || 14) * 24 * 60 * 60_000;

  for (const page of getPages()) {
    const items = await fetchPageComments(page, sinceMs);
    result.pulled += items.length;

    for (const item of items) {
      // Dedupe
      const existing = db.prepare(
        `SELECT id FROM care_comments WHERE source = 'facebook' AND source_id = ?`,
      ).get(item.source_id);
      if (existing) continue;
      result.new++;

      // Classify
      let s: any = { sentiment: 'unknown', score: 0, is_question: false };
      if (item.text && item.text.trim().length > 1) {
        const r = await classifySentiment(item.text, 'comment');
        if (r) { s = r; result.classified++; }
      }
      if (s.is_question) result.questions++;

      // "needs_response" = a question OR a negative comment by non-staff
      const needsResponse = s.is_question || s.sentiment === 'negative';
      if (needsResponse) result.needs_response++;

      db.prepare(
        `INSERT INTO care_comments
         (source, source_id, parent_post_id, fb_page_id, author_name, author_id,
          text, sentiment, sentiment_score, is_question, needs_response, has_response,
          detected_at, notified_admin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'facebook', item.source_id, item.parent_post_id, page.fb_page_id,
        item.author_name, item.author_id,
        item.text, s.sentiment, s.score || null,
        s.is_question ? 1 : 0, needsResponse ? 1 : 0, 0,
        Date.now(), 0,
      );

      // Alert for negative or urgent
      if (s.sentiment === 'negative' || s.is_urgent) {
        try {
          const { notifyAll } = require('../telegram');
          await notifyAll(
            `⚠️ *Negative comment on FB post*\n` +
            `Page: ${page.name}\n` +
            `Author: ${item.author_name || 'anon'}\n` +
            `Sentiment: ${s.sentiment}\n\n` +
            `"${(item.text || '').slice(0, 300)}"\n\n` +
            `→ https://app.sondervn.com/admin/care/dashboard`,
          );
          db.prepare(`UPDATE care_comments SET notified_admin = 1 WHERE source_id = ?`).run(item.source_id);
        } catch {}
      }
    }
  }

  console.log(`[care-inbox] sync: pulled=${result.pulled} new=${result.new} classified=${result.classified} questions=${result.questions} needs_response=${result.needs_response}`);
  return result;
}

/** List comments for admin view. */
export function listComments(opts?: {
  sentiment?: 'positive' | 'negative' | 'neutral';
  is_question?: boolean;
  needs_response?: boolean;
  limit?: number;
}): any[] {
  let sql = `SELECT * FROM care_comments WHERE 1=1`;
  const params: any[] = [];
  if (opts?.sentiment) { sql += ` AND sentiment = ?`; params.push(opts.sentiment); }
  if (opts?.is_question !== undefined) sql += ` AND is_question = ${opts.is_question ? 1 : 0}`;
  if (opts?.needs_response !== undefined) sql += ` AND needs_response = ${opts.needs_response ? 1 : 0}`;
  sql += ` ORDER BY detected_at DESC LIMIT ?`;
  params.push(opts?.limit || 100);
  return db.prepare(sql).all(...params) as any[];
}

export function inboxStats(): any {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM care_comments`).get() as any).n;
  const needs_response = (db.prepare(`SELECT COUNT(*) AS n FROM care_comments WHERE needs_response = 1 AND has_response = 0`).get() as any).n;
  const questions = (db.prepare(`SELECT COUNT(*) AS n FROM care_comments WHERE is_question = 1 AND has_response = 0`).get() as any).n;
  const last_24h = (db.prepare(`SELECT COUNT(*) AS n FROM care_comments WHERE detected_at > ?`).get(Date.now() - 86400_000) as any).n;
  return { total, needs_response, questions, last_24h };
}

export function markCommentResponded(commentId: number): void {
  db.prepare(`UPDATE care_comments SET has_response = 1 WHERE id = ?`).run(commentId);
}
