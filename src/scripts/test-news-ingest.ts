/**
 * Phase N-1 smoke: fetch 1 RSS source, show parsed items + DB insertion.
 */
import { db } from '../db';
import { getEnabledSources } from '../services/news-sources';
import { ingestSource, ingestAll, parseRSS } from '../services/news-ingest';

async function main() {
  // Test 1: parser robustness with minimal RSS
  console.log('=== Test 1: Parser with mini RSS ===');
  const mini = `<?xml version="1.0"?>
<rss><channel><title>Test</title>
  <item><title>Article A</title><link>https://example.com/a</link><pubDate>Thu, 20 Apr 2026 08:00:00 GMT</pubDate><description><![CDATA[Desc A]]></description></item>
  <item><title>Article B</title><link>https://example.com/b</link><pubDate>Thu, 20 Apr 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;
  const parsed = parseRSS(mini);
  console.log('  parsed count:', parsed.length);
  console.log('  item 0:', parsed[0]);

  // Test 2: fetch 1 real source (VnExpress Du lich — fast + Vietnamese)
  console.log('\n=== Test 2: Ingest VnExpress Du lich ===');
  const sources = getEnabledSources();
  const vnx = sources.find(s => s.id === 'vnexpress_dulich');
  if (!vnx) { console.error('vnexpress_dulich not in whitelist'); return; }
  const r = await ingestSource(vnx);
  console.log('  result:', r);

  // Test 3: show recent articles
  console.log('\n=== Test 3: Recent articles in DB ===');
  const recent = db.prepare(
    `SELECT id, source, title, lang, status, published_at FROM news_articles
     ORDER BY published_at DESC LIMIT 5`
  ).all();
  console.table(recent.map((r: any) => ({
    id: r.id, src: r.source, lang: r.lang,
    title: r.title.slice(0, 60),
    pub: new Date(r.published_at).toISOString().slice(0, 16),
  })));

  console.log('\n=== Test 4: Ingest all enabled (sequential, rate-limited) ===');
  const all = await ingestAll();
  console.log('  aggregate:', all);

  console.log('\n=== Test 5: Count by source ===');
  const bySource = db.prepare(`SELECT source, COUNT(*) as n FROM news_articles GROUP BY source ORDER BY n DESC`).all();
  console.table(bySource);

  console.log('\n✅ Phase N-1 ingest smoke done');
}

main().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1); });
