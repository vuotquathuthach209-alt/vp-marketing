/**
 * Try set YT video private (privacy delete fallback when no delete scope).
 * youtube.upload scope may allow updating own videos' privacy status.
 */
const axios = require('axios');
const Database = require('better-sqlite3');

const VIDEO_ID = 'RwCIDxKa52k';

(async () => {
  const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
  const get = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value;
  const refresh = get('youtube_refresh_token');
  const cid = get('youtube_client_id');
  const cs = get('youtube_client_secret');
  db.close();

  // Get fresh access token
  const tokR = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({ refresh_token: refresh, client_id: cid, client_secret: cs, grant_type: 'refresh_token' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 },
  );
  const token = tokR.data.access_token;

  // Try update privacy to private
  try {
    const r = await axios.put(
      'https://www.googleapis.com/youtube/v3/videos?part=status',
      {
        id: VIDEO_ID,
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    console.log('YT update privacy response:');
    console.log('  status:', r.status);
    console.log('  data:', JSON.stringify(r.data, null, 2).slice(0, 800));
    if (r.status === 200) {
      console.log(`✅ Video ${VIDEO_ID} set to PRIVATE (effectively hidden from public)`);
    } else {
      console.log(`❌ Update failed — manual delete required via YouTube Studio`);
      console.log(`   URL: https://studio.youtube.com/video/${VIDEO_ID}/edit`);
    }
  } catch (e) {
    console.error('error:', e?.response?.data || e.message);
  }
})();
