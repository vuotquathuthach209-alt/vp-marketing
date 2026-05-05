/**
 * Quick check FAL job status for stuck POC #3.
 */
const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const key = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

const reqs = [
  ['Veo',     'fal-ai/veo3',     '019df641-66b0-75c3-b906-254a8922a25c'],
  ['Hailuo1', 'fal-ai/minimax',  '019df641-66ae-7582-998c-fb9fe18d427d'],
  ['Hailuo2', 'fal-ai/minimax',  '019df641-66e5-7d63-9126-2df6f38b89f8'],
  ['Seedance','fal-ai/bytedance','019df641-66f6-70c1-8f83-dfa67d431ea9'],
];

(async () => {
  for (const [label, mid, req] of reqs) {
    try {
      const r = await axios.get(`https://queue.fal.run/${mid}/requests/${req}/status`, {
        headers: { Authorization: `Key ${key}` },
        timeout: 30000,
      });
      console.log(`${label}: ${JSON.stringify(r.data).slice(0, 300)}`);
    } catch (e) {
      console.log(`${label} ERR: ${e.response?.status || e.message}`);
    }
  }
})();
