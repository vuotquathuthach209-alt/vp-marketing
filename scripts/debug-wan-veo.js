/**
 * Debug Wan + Veo poll/fetch — check if status URLs work for those models.
 */
const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const KEY = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

const auth = { Authorization: `Key ${KEY}` };

// Submit fresh Wan + Veo small jobs, poll, then test multiple fetch URL patterns
(async () => {
  console.log('\n=== TEST 1: WAN submit + status + fetch URL patterns ===');
  try {
    const r = await axios.post(
      'https://queue.fal.run/fal-ai/wan/v2.6/text-to-video',
      { prompt: 'macro raindrop on glass cinematic', duration: 4, aspect_ratio: '9:16', resolution: '720p' },
      { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    console.log('Wan submit:', r.status, JSON.stringify(r.data).slice(0, 300));
    const reqId = r.data.request_id;
    const statusUrl = r.data.status_url;
    const responseUrl = r.data.response_url;

    // Wait for completion
    console.log('\nPolling status...');
    let lastStatus = null;
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const sr = await axios.get(statusUrl, { headers: auth, timeout: 15000 });
        lastStatus = sr.data;
        console.log(`  [${i}] ${lastStatus.status} q_pos=${lastStatus.queue_position||0}`);
        if (lastStatus.status === 'COMPLETED' || lastStatus.status === 'FAILED') break;
      } catch (e) {
        console.warn('  poll err:', e.response?.status, e.response?.data?.detail || e.message);
      }
    }

    if (lastStatus?.status === 'COMPLETED') {
      // Test fetch URL patterns
      const URLS = [
        ['response_url returned', responseUrl],
        ['full path constructed', `https://queue.fal.run/fal-ai/wan/v2.6/text-to-video/requests/${reqId}`],
        ['owner-only', `https://queue.fal.run/fal-ai/wan/requests/${reqId}`],
      ];
      for (const [label, url] of URLS) {
        try {
          const fr = await axios.get(url, { headers: auth, timeout: 15000, validateStatus: () => true });
          console.log(`  [${label}] ${fr.status}: keys=${Object.keys(fr.data || {}).join(',')}`);
          if (fr.status === 200) {
            console.log(`    video URL:`, fr.data?.video?.url || fr.data?.url || JSON.stringify(fr.data).slice(0, 200));
          }
        } catch (e) { console.log(`  [${label}] ERR:`, e.message); }
      }
    }
  } catch (e) {
    console.error('Wan ERR:', e.response?.status, e.response?.data?.detail || e.message);
  }
})();
