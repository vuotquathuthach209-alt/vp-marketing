/**
 * Customer Care SLA tracker.
 *
 * Runs as cron — checks for review/comment items that:
 *   - Are negative or urgent
 *   - Have no response yet
 *   - Exceeded SLA threshold (default 24h for negative, 4h for urgent)
 *
 * Emits Telegram alerts to admin with link to dashboard.
 */

import { db } from '../../db';

interface SlaConfig {
  urgent_review_max_hours: number;    // for is_urgent reviews
  negative_review_max_hours: number;
  negative_comment_max_hours: number;
  question_comment_max_hours: number;
}

function loadConfig(): SlaConfig {
  const { getSetting } = require('../../db');
  return {
    urgent_review_max_hours: parseFloat(getSetting('care_sla_urgent_review_hours') || '4'),
    negative_review_max_hours: parseFloat(getSetting('care_sla_negative_review_hours') || '24'),
    negative_comment_max_hours: parseFloat(getSetting('care_sla_negative_comment_hours') || '12'),
    question_comment_max_hours: parseFloat(getSetting('care_sla_question_comment_hours') || '24'),
  };
}

interface OverdueItem {
  type: 'review' | 'comment';
  source_table: string;
  id: number;
  detected_at: number;
  detected_age_hours: number;
  sentiment: string | null;
  is_urgent: boolean;
  is_question: boolean;
  text: string;
  author: string;
  source: string;
  threshold_hours: number;
}

/** Find items that breached SLA + haven't been alerted yet. */
export function findOverdueItems(): OverdueItem[] {
  const cfg = loadConfig();
  const now = Date.now();
  const items: OverdueItem[] = [];

  // Reviews — negative or urgent
  const reviews = db.prepare(
    `SELECT id, source, author_name, text, sentiment, is_urgent, detected_at, has_response, notified_admin
     FROM care_reviews
     WHERE has_response = 0 AND (sentiment = 'negative' OR is_urgent = 1)`,
  ).all() as any[];

  for (const r of reviews) {
    const ageHours = (now - r.detected_at) / 3600_000;
    const threshold = r.is_urgent ? cfg.urgent_review_max_hours : cfg.negative_review_max_hours;
    if (ageHours > threshold) {
      items.push({
        type: 'review',
        source_table: 'care_reviews',
        id: r.id,
        detected_at: r.detected_at,
        detected_age_hours: +ageHours.toFixed(1),
        sentiment: r.sentiment,
        is_urgent: !!r.is_urgent,
        is_question: false,
        text: r.text || '',
        author: r.author_name || 'anonymous',
        source: r.source,
        threshold_hours: threshold,
      });
    }
  }

  // Comments — negative or unanswered questions
  const comments = db.prepare(
    `SELECT id, source, author_name, text, sentiment, is_question, detected_at, has_response, needs_response
     FROM care_comments
     WHERE has_response = 0 AND needs_response = 1`,
  ).all() as any[];

  for (const c of comments) {
    const ageHours = (now - c.detected_at) / 3600_000;
    const threshold = c.is_question
      ? cfg.question_comment_max_hours
      : c.sentiment === 'negative'
        ? cfg.negative_comment_max_hours
        : 48;
    if (ageHours > threshold) {
      items.push({
        type: 'comment',
        source_table: 'care_comments',
        id: c.id,
        detected_at: c.detected_at,
        detected_age_hours: +ageHours.toFixed(1),
        sentiment: c.sentiment,
        is_urgent: false,
        is_question: !!c.is_question,
        text: c.text || '',
        author: c.author_name || 'anonymous',
        source: c.source,
        threshold_hours: threshold,
      });
    }
  }

  // Sort by severity: urgent first, then most-overdue
  items.sort((a, b) => {
    if (a.is_urgent !== b.is_urgent) return a.is_urgent ? -1 : 1;
    return b.detected_age_hours - a.detected_age_hours;
  });

  return items;
}

/** Send Telegram alert summary for overdue items. */
export async function runSlaCheck(): Promise<{ overdue: number; alerted: boolean }> {
  const overdue = findOverdueItems();
  if (overdue.length === 0) return { overdue: 0, alerted: false };

  // Group + format
  const lines: string[] = [
    `⏰ *SLA breach — ${overdue.length} item(s) overdue*`,
    ``,
  ];

  const urgent = overdue.filter((i) => i.is_urgent);
  const negative = overdue.filter((i) => !i.is_urgent && i.sentiment === 'negative');
  const questions = overdue.filter((i) => i.is_question);
  const other = overdue.filter((i) => !i.is_urgent && i.sentiment !== 'negative' && !i.is_question);

  if (urgent.length > 0) {
    lines.push(`🚨 *URGENT* (${urgent.length}):`);
    for (const i of urgent.slice(0, 5)) {
      lines.push(`  • ${i.author} (${i.detected_age_hours}h, source=${i.source})`);
      lines.push(`    "${i.text.slice(0, 100)}"`);
    }
    lines.push(``);
  }
  if (negative.length > 0) {
    lines.push(`⚠️ *Negative reviews* (${negative.length}):`);
    for (const i of negative.slice(0, 5)) {
      lines.push(`  • ${i.author} (${i.detected_age_hours}h)`);
      lines.push(`    "${i.text.slice(0, 100)}"`);
    }
    lines.push(``);
  }
  if (questions.length > 0) {
    lines.push(`❓ *Unanswered questions* (${questions.length}):`);
    for (const i of questions.slice(0, 5)) {
      lines.push(`  • ${i.author} (${i.detected_age_hours}h): "${i.text.slice(0, 80)}"`);
    }
    lines.push(``);
  }
  if (other.length > 0) {
    lines.push(`📌 Other (${other.length}) — see dashboard`);
    lines.push(``);
  }

  lines.push(`→ Dashboard: https://app.sondervn.com/admin/care/dashboard`);

  try {
    const { notifyAll } = require('../telegram');
    await notifyAll(lines.join('\n'));
    return { overdue: overdue.length, alerted: true };
  } catch (e: any) {
    console.warn('[care-sla] notify fail:', e?.message);
    return { overdue: overdue.length, alerted: false };
  }
}
