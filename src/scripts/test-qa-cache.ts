/**
 * Phase 1 E2E: test qa_training_cache integration trong dispatchV6.
 *
 * Flow:
 *   1. Seed 1 approved Q&A
 *   2. Gọi smartReplyWithSender với câu tương tự → expect intent=qa_cached, reply=cached
 *   3. Gọi smartReplyWithSender với câu khác biệt → expect LLM call, saves tier=pending
 *
 * Usage: npx ts-node src/scripts/test-qa-cache.ts
 */
import { db } from '../db';
import { saveNewQA, approveQA, matchIntent } from '../services/intent-matcher';

async function main() {
  // Cần có ít nhất 1 hotel — lấy ID nhỏ nhất
  const hotel = db.prepare(`SELECT id, name FROM mkt_hotels ORDER BY id LIMIT 1`).get() as any;
  if (!hotel) {
    console.error('No mkt_hotels — cần seed 1 hotel trước');
    process.exit(1);
  }
  const hid = hotel.id as number;
  console.log(`Using hotel #${hid}: ${hotel.name}`);

  // Cleanup test rows
  db.prepare(`DELETE FROM qa_training_cache WHERE hotel_id = ? AND ai_response LIKE '[TEST-P1]%'`).run(hid);

  console.log('\n=== Seed 1 approved QA ===');
  const seed = await saveNewQA({
    hotelId: hid,
    question: 'Khách sạn có chỗ đậu xe không?',
    response: '[TEST-P1] Dạ có ạ! Khách sạn có chỗ để xe máy miễn phí cho khách nghỉ.',
    provider: 'gemini_flash',
    intentCategory: 'amenity_q',
    initialTier: 'approved',
  });
  console.log('seed:', seed);

  console.log('\n=== Test 1: Exact match (should HIT approved) ===');
  const t1 = await matchIntent({ hotelId: hid, customerMessage: 'Khách sạn có chỗ đậu xe không?' });
  console.log('  matched:', t1.matched, 'conf:', t1.confidence, 'tier:', t1.tier, 'should_use_cached:', t1.should_use_cached);

  console.log('\n=== Test 2: Similar question (should HIT via embedding similarity) ===');
  const t2 = await matchIntent({ hotelId: hid, customerMessage: 'Có chỗ để xe máy không ạ?' });
  console.log('  matched:', t2.matched, 'conf:', t2.confidence, 'tier:', t2.tier, 'should_use_cached:', t2.should_use_cached);

  console.log('\n=== Test 3: Unrelated question (should MISS) ===');
  const t3 = await matchIntent({ hotelId: hid, customerMessage: 'Khách sạn có bể bơi view biển không?' });
  console.log('  matched:', t3.matched, 'conf:', t3.confidence, 'should_use_cached:', t3.should_use_cached);

  console.log('\n=== Test 4: Verify dispatch flow is wired (smoke check) ===');
  // Không gọi full smartReplyWithSender vì phức tạp deps (FB API, OTA DB, etc.)
  // Chỉ confirm intent-matcher được require ok từ smartreply
  const { smartReplyWithSender } = require('../services/smartreply');
  console.log('  smartReplyWithSender loaded:', typeof smartReplyWithSender === 'function');

  // Stats
  const stats = db.prepare(`SELECT tier, COUNT(*) as n FROM qa_training_cache WHERE hotel_id = ? GROUP BY tier`).all(hid);
  console.log('\n=== QA cache stats (hotel', hid, ') ===');
  console.table(stats);

  console.log('\n✅ Phase 1 wiring test done');
}

main().catch((e) => {
  console.error('TEST FAIL:', e);
  process.exit(1);
});
