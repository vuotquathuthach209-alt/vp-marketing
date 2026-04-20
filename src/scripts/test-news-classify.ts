/**
 * Phase N-2 smoke: classify 10 articles pending.
 * Xem kết quả passed / filtered.
 */
import { db } from '../db';
import { keywordGate, classifyWithGemini, classifyBatch, classifyArticle } from '../services/news-classifier';

async function main() {
  // Test 1: keywordGate unit
  console.log('=== Test 1: keywordGate ===');
  console.log('  "Khách sạn Sonder có wifi không":',
    keywordGate('Khách sạn Sonder có wifi không', null, 'vi'));
  console.log('  "Giá vàng hôm nay":',
    keywordGate('Giá vàng hôm nay', null, 'vi'));
  console.log('  "Hotels in Dubai report 40% cancellations":',
    keywordGate('Hotels in Dubai report 40% cancellations', 'Amid tension, airlines reduce flights.', 'en'));

  // Test 2: AI classifier trên 1 article thật
  console.log('\n=== Test 2: AI classifier trên article thật ===');
  const sample = db.prepare(
    `SELECT id, title, body, lang FROM news_articles
     WHERE status='ingested' AND lang='vi'
     ORDER BY published_at DESC LIMIT 1`
  ).get() as any;
  if (sample) {
    console.log(`  Title: "${sample.title}"`);
    const cls = await classifyWithGemini(sample.title, sample.body);
    console.log('  Classifier:', cls);
  }

  // Test 3: 1 article classifyArticle full (status update)
  console.log('\n=== Test 3: Full classifyArticle loop ===');
  const pick = db.prepare(
    `SELECT id, title FROM news_articles WHERE status='ingested' ORDER BY published_at DESC LIMIT 1`
  ).get() as any;
  if (pick) {
    console.log(`  Processing article #${pick.id}: "${pick.title.slice(0, 70)}"`);
    const result = await classifyArticle(pick.id);
    console.log('  Verdict:', result);
    const after = db.prepare(
      `SELECT status, status_note, is_travel_relevant, impact_score, political_risk, region, angle_hint
       FROM news_articles WHERE id = ?`
    ).get(pick.id);
    console.log('  After:', after);
  }

  // Test 4: batch 10 articles
  console.log('\n=== Test 4: Batch classify 10 articles ===');
  const r = await classifyBatch(10);
  console.log('  Result:', r);

  // Test 5: show current status distribution
  console.log('\n=== Test 5: Status distribution ===');
  const stats = db.prepare(
    `SELECT status, COUNT(*) as n FROM news_articles GROUP BY status ORDER BY n DESC`
  ).all();
  console.table(stats);

  // Test 6: show passed articles (angle_generated)
  console.log('\n=== Test 6: Sample passed articles ===');
  const passed = db.prepare(
    `SELECT id, source, title, impact_score, political_risk, region, angle_hint
     FROM news_articles WHERE status='angle_generated'
     ORDER BY impact_score DESC LIMIT 5`
  ).all();
  console.table(passed.map((p: any) => ({
    id: p.id,
    src: p.source.slice(0, 15),
    title: p.title.slice(0, 55),
    impact: p.impact_score,
    pol: p.political_risk,
    region: p.region,
    angle: p.angle_hint?.slice(0, 50),
  })));

  console.log('\n✅ Phase N-2 classifier smoke done');
}

main().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1); });
