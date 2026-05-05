/**
 * Take down ep#14 violating clip:
 *   - DELETE FB Reels post 1906708880038194 via Graph API
 *   - DELETE YT video RwCIDxKa52k via YouTube Data API v3
 *   - Reset DB row status to 'approved' (rendered video kept locally)
 *   - Local mp4 will be re-rendered with new BGM in next step
 */

const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = '/opt/vp-marketing/data/db.sqlite';
const EP_ID = 14;
const FB_POST_ID = '1906708880038194';
const FB_PAGE_ID = '892083053979896';   // Sonder Apartment Hotel
const YT_VIDEO_ID = 'RwCIDxKa52k';

const GRAPH = 'https://graph.facebook.com/v22.0';
const YT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function getSetting(key) {
  const db = new Database(DB_PATH, { readonly: true });
  const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  db.close();
  return r?.value;
}

function getPageAccessToken(pageId) {
  const db = new Database(DB_PATH, { readonly: true });
  const r = db.prepare(`SELECT access_token FROM pages WHERE fb_page_id = ?`).get(pageId);
  db.close();
  return r?.access_token;
}

async function getYoutubeAccessToken() {
  const clientId = getSetting('youtube_client_id');
  const clientSecret = getSetting('youtube_client_secret');
  const refreshToken = getSetting('youtube_refresh_token');
  if (!clientId || !clientSecret || !refreshToken) throw new Error('YT OAuth not configured');

  const r = await axios.post(YT_TOKEN_URL, new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  return r.data.access_token;
}

async function deleteFbPost() {
  const token = getPageAccessToken(FB_PAGE_ID);
  if (!token) {
    console.error('❌ FB: page access token not found for', FB_PAGE_ID);
    return false;
  }
  try {
    const r = await axios.delete(`${GRAPH}/${FB_POST_ID}`, {
      params: { access_token: token },
      timeout: 30000,
    });
    console.log('✅ FB: post deleted', FB_POST_ID, '→', JSON.stringify(r.data));
    return true;
  } catch (e) {
    const errMsg = e?.response?.data?.error?.message || e?.message;
    console.error('❌ FB delete failed:', errMsg);
    if (errMsg?.toLowerCase().includes('does not exist') || errMsg?.toLowerCase().includes('not found')) {
      console.log('   (post may already be removed by FB Content ID — treating as success)');
      return true;
    }
    return false;
  }
}

async function deleteYtVideo() {
  try {
    const token = await getYoutubeAccessToken();
    const r = await axios.delete('https://www.googleapis.com/youtube/v3/videos', {
      params: { id: YT_VIDEO_ID },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
      validateStatus: (s) => s === 204 || s === 404,        // 204 = deleted, 404 = already gone
    });
    if (r.status === 204) {
      console.log('✅ YT: video deleted', YT_VIDEO_ID);
      return true;
    }
    if (r.status === 404) {
      console.log('✅ YT: video already not found (treated as deleted)', YT_VIDEO_ID);
      return true;
    }
    return false;
  } catch (e) {
    const errMsg = e?.response?.data?.error?.message || e?.message;
    console.error('❌ YT delete failed:', errMsg);
    return false;
  }
}

async function resetDbRow() {
  const db = new Database(DB_PATH);
  // Reset to 'approved' so re-render can run, clear FB/YT IDs
  const r = db.prepare(`
    UPDATE story_episodes
    SET status = 'approved',
        fb_post_ids = NULL,
        yt_video_id = NULL,
        published_at = NULL,
        error = 're-render after BGM violation 2026-05-05',
        updated_at = ?
    WHERE id = ?
  `).run(Date.now(), EP_ID);
  db.close();
  console.log(`✅ DB: ep#${EP_ID} status reset to 'approved' (changes: ${r.changes})`);
}

(async () => {
  console.log('═'.repeat(70));
  console.log(`Taking down ep#${EP_ID} (BGM copyright violation)`);
  console.log('═'.repeat(70));

  const fbOk = await deleteFbPost();
  const ytOk = await deleteYtVideo();

  if (fbOk || ytOk) {
    await resetDbRow();
    console.log('\n=== Take-down complete ===');
    console.log(`FB: ${fbOk ? '✅' : '❌'} | YT: ${ytOk ? '✅' : '❌'}`);
    console.log('Next: re-render ep#14 with new BGM, then re-publish');
  } else {
    console.error('\n❌ Both platforms failed — manual intervention needed');
    process.exit(1);
  }
})();
