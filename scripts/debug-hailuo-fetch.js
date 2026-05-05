/**
 * Debug Hailuo + Wan fetch URL — figure out actual pattern needed.
 */
const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const KEY = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

const auth = { Authorization: `Key ${KEY}` };

const HAILUO_REQ = '019df76d-b698-7360-82a3-321ac286f086';   // shot 5 retry from logs
const WAN_REQ = '019df76b-43af-7f51-b969-1c0e7f68387d';       // also try this

const URL_PATTERNS = [
  // Pattern 1: full path
  { label: 'hailuo full', url: `https://queue.fal.run/fal-ai/minimax/hailuo-02/pro/text-to-video/requests/${HAILUO_REQ}` },
  // Pattern 2: status URL (worked for poll)
  { label: 'hailuo status URL', url: `https://queue.fal.run/fal-ai/minimax/requests/${HAILUO_REQ}/status` },
  // Pattern 3: owner-only fetch URL
  { label: 'hailuo owner-only', url: `https://queue.fal.run/fal-ai/minimax/requests/${HAILUO_REQ}` },
  // Pattern 4: hailuo-specific submodel
  { label: 'hailuo with hailuo-02 only', url: `https://queue.fal.run/fal-ai/minimax/hailuo-02/requests/${HAILUO_REQ}` },
];

(async () => {
  for (const p of URL_PATTERNS) {
    try {
      const r = await axios.get(p.url, { headers: auth, timeout: 15000, validateStatus: () => true });
      console.log(`[${p.label}] status=${r.status}`);
      if (r.status === 200) {
        console.log('  data keys:', Object.keys(r.data));
        console.log('  data:', JSON.stringify(r.data).slice(0, 500));
      } else {
        console.log('  detail:', JSON.stringify(r.data).slice(0, 200));
      }
    } catch (e) {
      console.log(`[${p.label}] ERR: ${e.message}`);
    }
    console.log();
  }
})();
