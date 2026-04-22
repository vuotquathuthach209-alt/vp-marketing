"""Verify FB post published + delete test draft."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
(async () => {
  const Database = require('better-sqlite3');
  const axios = require('axios');
  const db = new Database('data/db.sqlite');

  const draft = db.prepare(`SELECT rd.*, p.access_token, p.fb_page_id FROM remix_drafts rd JOIN pages p ON p.hotel_id = rd.hotel_id WHERE rd.id = 2 LIMIT 1`).get();
  if (!draft) { console.log('No draft #2'); return; }
  console.log('Draft #2 status:', draft.status, 'FB post:', draft.fb_post_id);

  // Verify FB post exists
  try {
    const r = await axios.get(`https://graph.facebook.com/v18.0/${draft.fb_post_id}`, {
      params: { access_token: draft.access_token, fields: 'id,message,created_time,permalink_url' },
      timeout: 10000,
    });
    console.log('✅ FB post accessible:');
    console.log('  URL:', r.data.permalink_url);
    console.log('  Created:', r.data.created_time);
    console.log('  Message len:', (r.data.message || '').length);
  } catch (e) {
    console.log('❌ FB verify fail:', e.response?.data?.error?.message || e.message);
  }

  db.close();
})();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
