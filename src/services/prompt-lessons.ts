/**
 * Prompt Lessons — extract supervised signals từ conversation_labels (v13).
 *
 * Workflow:
 *   Admin labels bot reply as 'bad' / 'wrong_info' + provides 'corrected_reply'
 *   → extractLesson creates a `prompt_lessons` row
 *   → injectLessons() prepends relevant lessons to LLM system prompts
 */

import { db } from '../db';

export interface Lesson {
  id: number;
  lesson_type: 'avoid' | 'prefer' | 'tone' | 'fact_correction';
  context: string;
  description: string;
  example_bad?: string;
  example_good?: string;
  active: boolean;
}

/** Process new conversation_labels → extract lessons. Idempotent. */
export function extractLessonsFromLabels(): { created: number; skipped: number } {
  const now = Date.now();
  let created = 0, skipped = 0;

  // Find unprocessed labels (not yet in prompt_lessons.source_label_id)
  const labels = db.prepare(
    `SELECT cl.*, bro.user_message, bro.bot_reply, bro.reply_source, bro.stage
     FROM conversation_labels cl
     LEFT JOIN bot_reply_outcomes bro ON bro.id = cl.outcome_id
     WHERE cl.label IN ('bad', 'wrong_info', 'needs_rewrite', 'off_topic')
       AND NOT EXISTS (
         SELECT 1 FROM prompt_lessons pl WHERE pl.source_label_id = cl.id
       )
     ORDER BY cl.id DESC
     LIMIT 50`
  ).all() as any[];

  for (const lbl of labels) {
    if (!lbl.corrected_reply && !lbl.notes) { skipped++; continue; }

    // Determine lesson_type from label
    const lessonType = {
      bad: 'avoid',
      wrong_info: 'fact_correction',
      needs_rewrite: 'prefer',
      off_topic: 'avoid',
    }[lbl.label as string] || 'avoid';

    // Context = reply_source or stage or 'any'
    const context = lbl.reply_source || lbl.stage || 'any';

    // Description: use admin note or synthesize
    const description = lbl.notes || `When context=${context}, avoid pattern like: "${(lbl.bot_reply || '').slice(0, 80)}..."`;

    db.prepare(
      `INSERT INTO prompt_lessons
       (hotel_id, lesson_type, context, description,
        example_bad, example_good, source_outcome_id, source_label_id,
        active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      lbl.hotel_id || 0,
      lessonType, context, description,
      (lbl.bot_reply || '').slice(0, 500),
      (lbl.corrected_reply || '').slice(0, 500),
      lbl.outcome_id, lbl.id,
      now, now,
    );
    created++;
  }

  if (created > 0 || skipped > 0) {
    console.log(`[prompt-lessons] extracted: created=${created} skipped=${skipped}`);
  }
  return { created, skipped };
}

/** Get active lessons for context (for prompt injection). */
export function getLessonsForContext(context: string, hotelId: number = 0, limit: number = 5): Lesson[] {
  // Try exact context match + 'any' fallback
  const rows = db.prepare(
    `SELECT id, lesson_type, context, description, example_bad, example_good, active
     FROM prompt_lessons
     WHERE active = 1 AND (hotel_id = ? OR hotel_id = 0)
       AND (context = ? OR context = 'any')
     ORDER BY (context = ?) DESC, injected_count ASC, id DESC
     LIMIT ?`
  ).all(hotelId, context, context, limit) as any[];
  return rows.map(r => ({ ...r, active: !!r.active }));
}

/** Format lessons as system prompt injection block. */
export function formatLessonsForPrompt(lessons: Lesson[]): string {
  if (lessons.length === 0) return '';

  const groups: Record<string, string[]> = {};
  for (const l of lessons) {
    if (!groups[l.lesson_type]) groups[l.lesson_type] = [];
    groups[l.lesson_type].push(`- ${l.description}`);
    // Increment inject count (async-ish, best effort)
    try { db.prepare(`UPDATE prompt_lessons SET injected_count = injected_count + 1 WHERE id = ?`).run(l.id); } catch {}
  }

  const sections: string[] = ['\n## Lessons learned (từ admin feedback):'];
  if (groups.avoid) sections.push(`**AVOID:**\n${groups.avoid.join('\n')}`);
  if (groups.prefer) sections.push(`**PREFER:**\n${groups.prefer.join('\n')}`);
  if (groups.tone) sections.push(`**TONE:**\n${groups.tone.join('\n')}`);
  if (groups.fact_correction) sections.push(`**FACT CORRECTIONS:**\n${groups.fact_correction.join('\n')}`);

  return sections.join('\n\n');
}

/** Convenience: inject lessons vào system prompt trước khi gửi LLM. */
export function enhanceSystemPromptWithLessons(basePrompt: string, context: string, hotelId: number = 0): string {
  const lessons = getLessonsForContext(context, hotelId);
  const lessonsBlock = formatLessonsForPrompt(lessons);
  if (!lessonsBlock) return basePrompt;
  return basePrompt + lessonsBlock;
}
