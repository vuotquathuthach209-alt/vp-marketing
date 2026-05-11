/**
 * Reviews monitor — aggregate FB recommendations + Google Maps reviews.
 *
 * Pull:
 *   - FB: GET /{page_id}/ratings?fields=...
 *   - Google: requires Google Places / Business Profile API (manual entry fallback)
 *
 * Each review → classify sentiment via Gemini → save → notify admin if negative/urgent.
 */

import axios from 'axios';
import { db } from '../../db';
import { classifySentiment } from './sentiment';
import type { ReviewSource } from './types';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PageRow { id: number; fb_page_id: string; access_token: string; name: string; }

function getPages(): PageRow[] {
  return db.prepare(`SELECT id, fb_page_id, access_token, name FROM pages`).all() as PageRow[];
}

/** Pull recent FB recommendations for one Page. */
async function fetchFbReviews(page: PageRow, sinceMs: number): Promise<Array<{
  source_id: string; author_name: string | null; author_id: string | null;
  text: string; recommendation_type: string | null; created_time_ms: number;
  has_owner_reply: boolean; owner_reply_text: string | null; owner_reply_at: number | null;
}>> {
  try {
    // FB Graph: /{page_id}/ratings returns reviews/recommendations
    // fields: rating (legacy), recommendation_type, review_text, reviewer.name, created_time, comments{from,message}
    const r = await axios.get(`${GRAPH}/${page.fb_page_id}/ratings`, {
      params: {
        fields: 'rating,recommendation_type,review_text,reviewer{id,name},created_time,open_graph_story{actions,comments.limit(5){from,message,created_time}}',
        access_token: page.access_token,
        limit: 50,
      },
      timeout: 20_000,
    });
    const items: any[] = r.data?.data || [];
    const out: any[] = [];
    for (const it of items) {
      const t = it.created_time ? new Date(it.created_time).getTime() : Date.now();
      if (t < sinceMs) continue;
      const text = (it.review_text || '').trim();
      if (!text && !it.recommendation_type) continue;

      // Check if owner already replied (via story comments where from.id == page_id)
      let hasOwnerReply = false;
      let ownerReplyText: string | null = null;
      let ownerReplyAt: number | null = null;
      const storyComments: any[] = it.open_graph_story?.comments?.data || [];
      for (const c of storyComments) {
        if (c?.from?.id === page.fb_page_id) {
          hasOwnerReply = true;
          ownerReplyText = c.message || null;
          ownerReplyAt = c.created_time ? new Date(c.created_time).getTime() : null;
          break;
        }
      }

      out.push({
        source_id: String(it.id || `fb_${page.fb_page_id}_${t}`),
        author_name: it.reviewer?.name || null,
        author_id: it.reviewer?.id || null,
        text,
        recommendation_type: it.recommendation_type || null,
        created_time_ms: t,
        has_owner_reply: hasOwnerReply,
        owner_reply_text: ownerReplyText,
        owner_reply_at: ownerReplyAt,
      });
    }
    return out;
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message;
    console.warn(`[care-reviews] FB fetch ${page.name} fail:`, msg);
    return [];
  }
}

/** Run sync: pull all FB pages + classify new reviews. */
export async function syncReviews(opts?: { since_days?: number }): Promise<{
  pulled: number;
  new: number;
  classified: number;
  errors: number;
  notified_admin: number;
}> {
  const result = { pulled: 0, new: 0, classified: 0, errors: 0, notified_admin: 0 };
  const sinceMs = Date.now() - (opts?.since_days || 90) * 24 * 60 * 60_000;

  for (const page of getPages()) {
    const items = await fetchFbReviews(page, sinceMs);
    result.pulled += items.length;

    for (const item of items) {
      // Check if already in DB (dedupe by source + source_id)
      const existing = db.prepare(
        `SELECT id, has_response FROM care_reviews WHERE source = 'facebook' AND source_id = ?`,
      ).get(item.source_id) as { id: number; has_response: number } | undefined;

      if (existing) {
        // Update if owner replied since last seen
        if (!existing.has_response && item.has_owner_reply) {
          db.prepare(
            `UPDATE care_reviews SET has_response = 1, response_text = ?, response_at = ?, last_seen_at = ? WHERE id = ?`,
          ).run(item.owner_reply_text, item.owner_reply_at, Date.now(), existing.id);
        } else {
          db.prepare(`UPDATE care_reviews SET last_seen_at = ? WHERE id = ?`).run(Date.now(), existing.id);
        }
        continue;
      }

      result.new++;

      // Classify sentiment
      let sentiment: any = { sentiment: 'unknown', score: 0, reason: '', is_urgent: false, language: null };
      if (item.text) {
        const s = await classifySentiment(item.text, 'review');
        if (s) { sentiment = s; result.classified++; }
      } else if (item.recommendation_type) {
        sentiment.sentiment = item.recommendation_type === 'positive' ? 'positive' : 'negative';
        sentiment.score = item.recommendation_type === 'positive' ? 0.7 : -0.7;
        sentiment.reason = `FB recommends: ${item.recommendation_type}`;
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO care_reviews
         (source, source_id, hotel_id, fb_page_id, author_name, author_id,
          rating, recommendation_type, text, language,
          sentiment, sentiment_score, sentiment_reason, is_urgent,
          has_response, response_text, response_at,
          created_at_source, detected_at, last_seen_at, notified_admin, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'facebook', item.source_id, null, page.fb_page_id,
        item.author_name, item.author_id,
        null, item.recommendation_type,
        item.text, sentiment.language,
        sentiment.sentiment, sentiment.score, sentiment.reason, sentiment.is_urgent ? 1 : 0,
        item.has_owner_reply ? 1 : 0, item.owner_reply_text, item.owner_reply_at,
        item.created_time_ms, now, now, 0, null,
      );

      // Notify admin if negative or urgent
      if (sentiment.sentiment === 'negative' || sentiment.is_urgent) {
        try {
          const { notifyAll } = require('../telegram');
          const lines = [
            sentiment.is_urgent ? '🚨 *URGENT REVIEW*' : '⚠️ *Negative review*',
            `Page: ${page.name}`,
            `Author: ${item.author_name || 'anonymous'}`,
            `Sentiment: ${sentiment.sentiment} (${sentiment.score.toFixed(2)})`,
            `Reason: ${sentiment.reason}`,
            ``,
            `"${item.text.slice(0, 400)}"`,
            ``,
            `→ Open: https://app.sondervn.com/admin/care/dashboard`,
          ];
          await notifyAll(lines.join('\n'));
          db.prepare(`UPDATE care_reviews SET notified_admin = 1 WHERE source_id = ?`).run(item.source_id);
          result.notified_admin++;
        } catch (e: any) {
          console.warn('[care-reviews] notify fail:', e?.message);
        }
      }
    }
  }

  console.log(`[care-reviews] sync: pulled=${result.pulled} new=${result.new} classified=${result.classified} notified=${result.notified_admin}`);
  return result;
}

/** Manually add a Google Maps review (admin enters from Google Business Profile). */
export function addManualGoogleReview(opts: {
  hotel_id?: number;
  author_name: string;
  rating: number;       // 1-5
  text: string;
  created_at_source?: number;
}): { id: number; sentiment: string } {
  const now = Date.now();
  const sourceId = `manual_google_${now}`;
  // Quick sentiment from rating
  const sentiment = opts.rating >= 4 ? 'positive' : opts.rating >= 3 ? 'neutral' : 'negative';
  const score = (opts.rating - 3) / 2;   // 1→-1, 3→0, 5→1

  const r = db.prepare(
    `INSERT INTO care_reviews
     (source, source_id, hotel_id, fb_page_id, author_name, author_id,
      rating, recommendation_type, text, language,
      sentiment, sentiment_score, sentiment_reason, is_urgent,
      has_response, response_text, response_at,
      created_at_source, detected_at, last_seen_at, notified_admin, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'google_maps', sourceId, opts.hotel_id || null, null,
    opts.author_name, null,
    opts.rating, null,
    opts.text, null,
    sentiment, score, `Rating ${opts.rating}/5`, 0,
    0, null, null,
    opts.created_at_source || now, now, now, 0, null,
  );

  // Trigger AI sentiment refinement in background
  classifySentiment(opts.text, 'review').then((s) => {
    if (s) {
      db.prepare(
        `UPDATE care_reviews SET sentiment = ?, sentiment_score = ?, sentiment_reason = ?, is_urgent = ?, language = ? WHERE id = ?`,
      ).run(s.sentiment, s.score, s.reason, s.is_urgent ? 1 : 0, s.language, r.lastInsertRowid);
    }
  }).catch(() => {});

  return { id: r.lastInsertRowid as number, sentiment };
}

/** List reviews with filter. */
export function listReviews(opts?: {
  source?: ReviewSource;
  sentiment?: 'positive' | 'negative' | 'neutral';
  needs_response?: boolean;
  is_urgent?: boolean;
  limit?: number;
}): any[] {
  let sql = `SELECT * FROM care_reviews WHERE 1=1`;
  const params: any[] = [];
  if (opts?.source) { sql += ` AND source = ?`; params.push(opts.source); }
  if (opts?.sentiment) { sql += ` AND sentiment = ?`; params.push(opts.sentiment); }
  if (opts?.needs_response) sql += ` AND has_response = 0 AND sentiment IN ('negative', 'neutral')`;
  if (opts?.is_urgent) sql += ` AND is_urgent = 1`;
  sql += ` ORDER BY created_at_source DESC LIMIT ?`;
  params.push(opts?.limit || 100);
  return db.prepare(sql).all(...params) as any[];
}

/** Stats for dashboard. */
export function reviewStats(): any {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM care_reviews`).get() as any).n;
  const bySentiment = db.prepare(`SELECT sentiment, COUNT(*) AS n FROM care_reviews GROUP BY sentiment`).all() as any[];
  const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM care_reviews GROUP BY source`).all() as any[];
  const last7d = (db.prepare(`SELECT COUNT(*) AS n FROM care_reviews WHERE created_at_source > ?`).get(Date.now() - 7 * 86400_000) as any).n;
  const needs_response = (db.prepare(`SELECT COUNT(*) AS n FROM care_reviews WHERE has_response = 0 AND sentiment IN ('negative', 'neutral')`).get() as any).n;
  const urgent = (db.prepare(`SELECT COUNT(*) AS n FROM care_reviews WHERE is_urgent = 1`).get() as any).n;
  const avgScore = db.prepare(`SELECT AVG(sentiment_score) AS avg FROM care_reviews WHERE sentiment_score IS NOT NULL`).get() as any;

  return {
    total,
    last_7d: last7d,
    needs_response,
    urgent,
    avg_sentiment_score: avgScore?.avg || 0,
    by_sentiment: bySentiment,
    by_source: bySource,
  };
}

/** Mark a review as responded (when admin replies manually via FB UI). */
export function markResponded(reviewId: number, responseText?: string): void {
  db.prepare(
    `UPDATE care_reviews SET has_response = 1, response_text = ?, response_at = ? WHERE id = ?`,
  ).run(responseText || null, Date.now(), reviewId);
}
