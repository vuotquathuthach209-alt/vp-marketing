"""Check Zalo app credentials + refresh token state."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const axios = require('axios').default;
const db = new Database('data/db.sqlite');

(async () => {
  // 1. OA state
  const oa = db.prepare(`SELECT * FROM zalo_oa WHERE enabled = 1 LIMIT 1`).get();
  console.log('=== OA state ===');
  console.log('oa_id:', oa.oa_id, 'name:', oa.oa_name);
  console.log('has access_token:', !!oa.access_token, 'len:', oa.access_token?.length);
  console.log('has refresh_token:', !!oa.refresh_token, 'len:', oa.refresh_token?.length || 0);
  console.log('refresh_token preview:', oa.refresh_token?.slice(0, 30) + '...' + oa.refresh_token?.slice(-10));
  console.log('has app_secret_override:', !!oa.app_secret);

  // 2. App credentials from settings
  const appId = db.prepare(`SELECT value FROM settings WHERE key='zalo_app_id'`).get()?.value;
  const appSecret = db.prepare(`SELECT value FROM settings WHERE key='zalo_app_secret'`).get()?.value;
  console.log('\n=== App credentials (from settings) ===');
  console.log('zalo_app_id:', appId || 'MISSING');
  console.log('zalo_app_secret:', appSecret ? (appSecret.slice(0, 8) + '...' + appSecret.slice(-4)) : 'MISSING');

  // 3. Try refresh manually
  console.log('\n=== Manual refresh attempt ===');
  if (oa.refresh_token && appId && appSecret) {
    try {
      const r = await axios.post(
        'https://oauth.zaloapp.com/v4/oa/access_token',
        new URLSearchParams({
          refresh_token: oa.refresh_token,
          app_id: appId,
          grant_type: 'refresh_token',
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'secret_key': appSecret,
          },
          timeout: 15000,
        }
      );
      console.log('Refresh response:', JSON.stringify(r.data).slice(0, 500));
      if (r.data.access_token) {
        console.log('✅ REFRESH SUCCESS — new token received');
        console.log('   expires_in:', r.data.expires_in, 's (' + ((r.data.expires_in||0)/3600).toFixed(1) + 'h)');
      }
    } catch (e) {
      console.log('❌ Refresh error:', e.response?.data || e.message);
    }
  } else {
    console.log('❌ Missing refresh_token or app credentials');
  }

  // 4. Recent Zalo conversations — still active?
  console.log('\n=== Recent Zalo chat (last 1h) ===');
  const cutoff = Date.now() - 3600000;
  const recent = db.prepare(`SELECT sender_id, role, substr(message, 1, 60) as msg, datetime(created_at/1000, 'unixepoch', '+7 hours') as t_vn FROM conversation_memory WHERE sender_id LIKE 'zalo:%' AND created_at > ? ORDER BY id DESC LIMIT 5`).all(cutoff);
  console.log('Messages last 1h:', recent.length);
  recent.forEach(r => console.log('  [' + r.t_vn + '] ' + r.sender_id.slice(0, 20) + ' [' + r.role + ']: ' + r.msg));

  db.close();
})();
JS

node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()
