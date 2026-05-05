/**
 * Direct FAL test — bypass health probe cache.
 * Submits 1 small Seedance job + cancels immediately.
 */
const axios = require('axios');
const Database = require('better-sqlite3');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const KEY = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

(async () => {
  console.log('=== Direct FAL submit test ===');
  try {
    const r = await axios.post(
      'https://queue.fal.run/fal-ai/bytedance/seedance/v2/text-to-video',
      { prompt: 'macro raindrop on glass at night, cinematic', duration: 4, aspect_ratio: '9:16', resolution: '720p' },
      { headers: { Authorization: 'Key ' + KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true },
    );
    console.log('Status:', r.status);
    console.log('Response:', JSON.stringify(r.data).slice(0, 400));
    if (r.data?.request_id) {
      console.log('\nSUBMIT SUCCESSFUL - FAL working! Request ID:', r.data.request_id);
      console.log('Cancelling probe job to avoid charge...');
      try {
        await axios.put(
          'https://queue.fal.run/fal-ai/bytedance/requests/' + r.data.request_id + '/cancel',
          {},
          { headers: { Authorization: 'Key ' + KEY }, timeout: 10000, validateStatus: () => true },
        );
        console.log('  cancelled');
      } catch {}
    }
  } catch (e) {
    console.error('ERR:', e.response?.status || e.message);
    console.error(JSON.stringify(e.response?.data).slice(0, 400));
  }
})();
