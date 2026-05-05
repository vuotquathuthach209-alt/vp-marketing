/**
 * Submit a NEW small Seedance job, capture exact response_url, immediately try fetch.
 */
const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const key = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

(async () => {
  const auth = { Authorization: `Key ${key}` };
  const modelId = 'fal-ai/bytedance/seedance/v2/text-to-video';
  console.log('Submitting fresh Seedance job...');
  const submitR = await axios.post(
    `https://queue.fal.run/${modelId}`,
    { prompt: 'macro raindrop on glass, cinematic', duration: 4, aspect_ratio: '9:16', resolution: '720p' },
    { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 60000 },
  );
  console.log('Submit response:', JSON.stringify(submitR.data, null, 2));

  const { request_id, status_url, response_url } = submitR.data;
  console.log('\nWaiting for completion...');

  // Poll
  let lastStatus = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await axios.get(status_url, { headers: auth, timeout: 30000 });
      lastStatus = r.data;
      console.log(`[${i}] status=${lastStatus.status}`);
      if (lastStatus.status === 'COMPLETED' || lastStatus.status === 'FAILED') break;
    } catch (e) {
      console.warn(`poll err: ${e.response?.status} ${e.response?.data?.detail || e.message}`);
    }
  }

  if (lastStatus?.status !== 'COMPLETED') {
    console.log('not completed');
    return;
  }

  console.log('\nFetching result via response_url:', response_url);
  try {
    const r = await axios.get(response_url, { headers: auth, timeout: 30000 });
    console.log('result status:', r.status);
    console.log('keys:', Object.keys(r.data));
    console.log('video.url:', r.data.video?.url);
    console.log('full data:', JSON.stringify(r.data).slice(0, 500));
  } catch (e) {
    console.log('FETCH ERR:', e.response?.status, e.response?.data?.detail || e.message);
  }
})();
