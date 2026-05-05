/**
 * Test which URL pattern works for FAL fetch result on multi-slash models.
 */
const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const key = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

const REQ = '019df641-66f6-70c1-8f83-dfa67d431ea9';
const ownerOnly = `https://queue.fal.run/fal-ai/bytedance/requests/${REQ}`;
const fullPath = `https://queue.fal.run/fal-ai/bytedance/seedance/v2/text-to-video/requests/${REQ}`;

(async () => {
  for (const [label, url] of [['ownerOnly', ownerOnly], ['fullPath', fullPath]]) {
    try {
      const r = await axios.get(url, { headers: { Authorization: `Key ${key}` }, timeout: 30000 });
      console.log(`${label}: status=${r.status}, has video=${!!r.data?.video?.url}`);
      console.log('  data keys:', Object.keys(r.data));
      if (r.data?.video?.url) console.log('  video url:', r.data.video.url);
    } catch (e) {
      console.log(`${label} ERR: status=${e.response?.status} msg=${e.response?.data?.detail || e.message}`);
    }
  }
})();
