/**
 * Phase 1 quick smoke: verify matchIntent is live on current DB.
 * Chạy trực tiếp trên VPS để check cache.
 */
import { db } from '../db';
import { matchIntent } from '../services/intent-matcher';

async function main() {
  const row = db.prepare(`SELECT tier, COUNT(*) as n FROM qa_training_cache GROUP BY tier`).all();
  console.log('QA cache state:');
  console.table(row);

  const sample = db.prepare(`SELECT hotel_id, customer_question FROM qa_training_cache WHERE tier='approved' LIMIT 1`).get() as any;
  if (!sample) {
    console.log('No approved entries — seed 1 first');
    return;
  }
  console.log(`\nTesting match against approved Q: "${sample.customer_question}"`);

  const variations = [
    sample.customer_question,  // exact
    sample.customer_question.replace('ạ', ''),  // minor variation
    'Chỗ này có wifi xài miễn phí hông?',  // semantic similar
    'Giờ mấy có bể bơi không?',  // unrelated
  ];

  for (const q of variations) {
    const r = await matchIntent({ hotelId: sample.hotel_id, customerMessage: q });
    console.log(`  "${q}"`);
    console.log(`    matched=${r.matched} conf=${r.confidence} tier=${r.tier} use=${r.should_use_cached}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
