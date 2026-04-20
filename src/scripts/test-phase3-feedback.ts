/**
 * Phase 3 E2E: verify qa-feedback-tracker.
 *
 * 1. Seed 1 approved QA
 * 2. rememberLastReply simulate bot vừa trả
 * 3. analyzeFollowUp với các câu positive/negative/neutral
 * 4. Check feedback_score + positive_feedback + negative_feedback updated
 */
import { db } from '../db';
import { saveNewQA } from '../services/intent-matcher';
import { rememberLastReply, analyzeFollowUp, manualFeedback, getFeedbackStats } from '../services/qa-feedback-tracker';

async function main() {
  const hotel = db.prepare(`SELECT id FROM mkt_hotels ORDER BY id LIMIT 1`).get() as any;
  if (!hotel) { console.error('No hotel'); process.exit(1); }
  const hid = hotel.id;

  // Cleanup
  db.prepare(`DELETE FROM qa_training_cache WHERE ai_response LIKE '[TEST-P3]%'`).run();

  console.log('=== Seed approved QA ===');
  const seed = await saveNewQA({
    hotelId: hid,
    question: 'Khách sạn có gần sân bay không ạ?',
    response: '[TEST-P3] Dạ bên em cách sân bay 3km, đi xe máy 10 phút ạ.',
    provider: 'gemini_flash',
    intentCategory: 'location_q',
    initialTier: 'approved',
  });
  const qid = seed.qa_cache_id;
  console.log(`  qa_cache_id=${qid}`);

  // Test 1: positive (thanks)
  console.log('\n=== Test 1: Positive (thanks) ===');
  rememberLastReply('user_p3_a', { qa_cache_id: qid, bot_reply: 'seed response', user_question: 'gần sân bay', hotel_id: hid, is_cached_hit: true });
  const r1 = await analyzeFollowUp({ senderId: 'user_p3_a', message: 'ok cảm ơn bạn', hotelId: hid });
  console.log('  result:', r1);

  // Test 2: positive (phone)
  console.log('\n=== Test 2: Positive (phone) ===');
  rememberLastReply('user_p3_b', { qa_cache_id: qid, bot_reply: 'seed', user_question: 'gần sân bay', hotel_id: hid, is_cached_hit: false });
  const r2 = await analyzeFollowUp({ senderId: 'user_p3_b', message: 'số mình là 0912345678 nha', hotelId: hid });
  console.log('  result:', r2);

  // Test 3: negative (explicit)
  console.log('\n=== Test 3: Negative (explicit) ===');
  rememberLastReply('user_p3_c', { qa_cache_id: qid, bot_reply: 'seed', user_question: 'gần sân bay', hotel_id: hid, is_cached_hit: true });
  const r3 = await analyzeFollowUp({ senderId: 'user_p3_c', message: 'không phải ý mình, ý mình là có shuttle sân bay không', hotelId: hid });
  console.log('  result:', r3);

  // Test 4: negative (repeated question - same embedding)
  console.log('\n=== Test 4: Negative (repeated question via embedding) ===');
  rememberLastReply('user_p3_d', { qa_cache_id: qid, bot_reply: 'seed', user_question: 'Khách sạn có gần sân bay không ạ?', hotel_id: hid, is_cached_hit: true });
  const r4 = await analyzeFollowUp({ senderId: 'user_p3_d', message: 'ý mình là khách sạn có gần sân bay không?', hotelId: hid });
  console.log('  result:', r4);

  // Test 5: negative (handoff)
  console.log('\n=== Test 5: Negative (handoff) ===');
  rememberLastReply('user_p3_e', { qa_cache_id: qid, bot_reply: 'seed', user_question: 'gần sân bay', hotel_id: hid, is_cached_hit: true });
  const r5 = await analyzeFollowUp({ senderId: 'user_p3_e', message: 'cho mình gặp nhân viên đi', hotelId: hid });
  console.log('  result:', r5);

  // Test 6: no memory (expired / not set)
  console.log('\n=== Test 6: No memory (fresh sender) ===');
  const r6 = await analyzeFollowUp({ senderId: 'user_not_exist', message: 'câu bất kỳ', hotelId: hid });
  console.log('  result (should be null):', r6);

  // Test 7: admin manual
  console.log('\n=== Test 7: Admin manual positive ===');
  manualFeedback({ qa_cache_id: qid, sentiment: 'positive', note: 'admin review ok', admin_user_id: 1 });

  // Final stats on entry
  console.log('\n=== Final counters on qa_cache_id=' + qid + ' ===');
  const final = db.prepare(`SELECT feedback_score, positive_feedback, negative_feedback FROM qa_training_cache WHERE id = ?`).get(qid);
  console.log('  ', final);

  // Stats endpoint check
  console.log('\n=== Feedback stats (last 7 days) ===');
  const stats = getFeedbackStats(hid, Date.now() - 7 * 24 * 3600_000);
  console.log('  ', { total: stats.total, positive: stats.positive, negative: stats.negative, neutral: stats.neutral });

  console.log('\n✅ Phase 3 done');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
