"""Check recent FB posts (especially #12, #13) + test tokens against Graph API."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const axios = require('axios');

(async () => {
  const db = new Database('data/db.sqlite');

  // All posts (including drafts + all statuses)
  console.log('=== ALL posts (last 20 IDs) ===');
  const all = db.prepare(`SELECT id, page_id, status, scheduled_at, published_at, substr(error_message,1,200) as err FROM posts ORDER BY id DESC LIMIT 20`).all();
  all.forEach(p => {
    const sch = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString('vi-VN') : '-';
    console.log(`#${p.id} page=${p.page_id} status=${p.status} sched=${sch}`);
    if (p.err) console.log(`  ERR: ${p.err}`);
  });

  console.log(`\n=== Campaigns table (check #12, #13 from Telegram) ===`);
  try {
    const camp = db.prepare(`SELECT id, name, status FROM campaigns ORDER BY id DESC LIMIT 20`).all();
    camp.forEach(c => console.log(`  #${c.id} ${c.name} status=${c.status}`));
  } catch (e) { console.log('(no campaigns table):', e.message); }

  console.log(`\n=== news_post_drafts (news pipeline) ===`);
  try {
    const nd = db.prepare(`SELECT id, status, fb_post_id, substr(error,1,200) as err FROM news_post_drafts ORDER BY id DESC LIMIT 20`).all();
    nd.forEach(n => console.log(`  #${n.id} status=${n.status} fb=${n.fb_post_id || '-'} err=${n.err || '-'}`));
  } catch (e) { console.log('nd err:', e.message); }

  // Test tokens against Graph API
  console.log('\n=== Test FB tokens via Graph API ===');
  const pages = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages`).all();
  for (const p of pages) {
    try {
      const r = await axios.get(`https://graph.facebook.com/v19.0/me`, {
        params: { access_token: p.access_token, fields: 'id,name' },
        timeout: 10000, validateStatus: () => true
      });
      if (r.data?.error) {
        console.log(`❌ page=${p.name} (${p.fb_page_id}): ${r.data.error.message}`);
        console.log(`   code=${r.data.error.code} type=${r.data.error.type}`);
      } else {
        console.log(`✅ page=${p.name}: token OK → ${r.data.name} (id=${r.data.id})`);
      }
    } catch (e) { console.log(`❌ page=${p.name}: ${e.message}`); }
  }

  // Token debug — check when expired
  console.log('\n=== Debug token expiry ===');
  for (const p of pages) {
    try {
      const r = await axios.get(`https://graph.facebook.com/debug_token`, {
        params: { input_token: p.access_token, access_token: p.access_token },
        timeout: 10000, validateStatus: () => true
      });
      const d = r.data?.data;
      if (d) {
        console.log(`page=${p.name}:`);
        console.log(`  is_valid=${d.is_valid} type=${d.type}`);
        if (d.expires_at) console.log(`  expires_at=${new Date(d.expires_at * 1000).toLocaleString('vi-VN')}`);
        if (d.data_access_expires_at) console.log(`  data_access_expires_at=${new Date(d.data_access_expires_at * 1000).toLocaleString('vi-VN')}`);
        if (d.error) console.log(`  error: ${d.error.message} code=${d.error.code}`);
      } else console.log(`page=${p.name}: no debug data`, JSON.stringify(r.data).slice(0,200));
    } catch (e) { console.log(`debug err ${p.name}: ${e.message}`); }
  }

  db.close();
})();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
