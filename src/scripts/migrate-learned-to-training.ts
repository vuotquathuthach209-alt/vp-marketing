/**
 * Đợt 1.4: Migrate learned_qa_cache → qa_training_cache (tier='pending').
 *
 * Chỉ migrate entries có hits >= 3 (bot đã xài nhiều lần, đủ confidence).
 * Deduplication: nếu question đã tồn tại trong qa_training_cache thì skip.
 */
import { db } from '../db';
import { saveNewQA } from '../services/intent-matcher';

const MIN_HITS_TO_MIGRATE = 3;

async function main() {
  const rows = db.prepare(
    `SELECT id, hotel_id, question, answer, intent, hits, last_hit_at, created_at
     FROM learned_qa_cache WHERE hits >= ?
     ORDER BY hits DESC`
  ).all(MIN_HITS_TO_MIGRATE) as any[];

  console.log(`Found ${rows.length} learned entries với hits >= ${MIN_HITS_TO_MIGRATE}`);

  let migrated = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      const saved = await saveNewQA({
        hotelId: r.hotel_id,
        question: r.question,
        response: r.answer,
        provider: 'cache',
        intentCategory: r.intent || 'migrated_from_learned',
        contextTags: [`migrated_from_learned`, `original_hits=${r.hits}`],
        initialTier: 'pending',  // Cần admin duyệt
      });
      if (saved.is_new) {
        migrated++;
        console.log(`  MIGRATED #${saved.qa_cache_id}: "${r.question.slice(0, 60)}..."`);
      } else {
        skipped++;
      }
    } catch (e: any) {
      console.warn(`  FAIL migrate "${r.question.slice(0, 50)}":`, e?.message);
    }
  }

  console.log(`\n✅ Migrated: ${migrated}, Skipped (dupes): ${skipped}`);
  console.log('Admin giờ có thể vào tab "Duyệt Training" xem các entry này với context_tags=migrated_from_learned.');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
