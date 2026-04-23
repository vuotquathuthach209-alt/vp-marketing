"""Test v16 audiences end-to-end: verify tables, seed, refresh, preview members."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify 4 tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['marketing_audiences', 'audience_memberships', 'broadcast_campaigns', 'broadcast_sends'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Seed audiences ==="
cat > tmp.js <<'JS'
const { seedAudiences } = require('./dist/services/audience-seed');
const r = seedAudiences();
console.log(JSON.stringify(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. List all audiences ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT id, audience_name, display_name, refresh_interval_min, member_count, active FROM marketing_audiences ORDER BY id`).all();
rows.forEach(r => console.log('  #' + r.id + ' ' + r.audience_name + ' (' + r.member_count + ' members, refresh every ' + r.refresh_interval_min + 'min)'));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Force refresh all audiences ==="
cat > tmp.js <<'JS'
const { refreshAllAudiences } = require('./dist/services/marketing-audience-engine');
const results = refreshAllAudiences(true);
results.forEach(r => {
  const err = r.error ? ' ERR: ' + r.error : '';
  console.log('  ' + r.audience_name + ': ' + r.members_after + ' members (' + r.duration_ms + 'ms)' + err);
});
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Preview members (3 per audience) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const auds = db.prepare(`SELECT id, audience_name, member_count FROM marketing_audiences WHERE member_count > 0 ORDER BY audience_name`).all();
if (auds.length === 0) { console.log('  (no audience has members yet — DB data mới, cần thêm time + traffic)'); }
auds.forEach(a => {
  console.log('\n--- ' + a.audience_name + ' (' + a.member_count + ' members) ---');
  const members = db.prepare(`SELECT sender_id, customer_phone, customer_name, metadata FROM audience_memberships WHERE audience_id = ? LIMIT 3`).all(a.id);
  members.forEach(m => {
    const meta = m.metadata ? JSON.parse(m.metadata) : {};
    console.log('  ' + (m.customer_name || m.sender_id || '?') + ' (phone=' + (m.customer_phone || '-') + ') meta=' + JSON.stringify(meta).slice(0, 150));
  });
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 6. Test campaign creation (draft, don't send) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Find audience with members
const aud = db.prepare(`SELECT id, audience_name FROM marketing_audiences WHERE member_count > 0 LIMIT 1`).get();
if (!aud) { console.log('  (no audience with members — skip)'); db.close(); return; }

const now = Date.now();
const r = db.prepare(`
  INSERT INTO broadcast_campaigns
  (hotel_id, audience_id, name, channel, template_id, template_params, message_content, status, created_by, created_at, updated_at)
  VALUES (1, ?, ?, 'zalo_zns', 'test_template_001', ?, NULL, 'draft', 'test', ?, ?)
`).run(aud.id, 'Test campaign ' + aud.audience_name, JSON.stringify({date: '30/4', code: 'SONDER2026'}), now, now);
console.log('Created draft campaign #' + r.lastInsertRowid + ' targeting ' + aud.audience_name);
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 7. Dry-run send ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const camp = db.prepare(`SELECT id FROM broadcast_campaigns WHERE name LIKE 'Test campaign%' ORDER BY id DESC LIMIT 1`).get();
db.close();
if (!camp) { console.log('  (no test campaign found)'); return; }

const { sendCampaign } = require('./dist/services/broadcast-sender');
sendCampaign(camp.id, { dryRun: true }).then(r => {
  console.log('Dry run result:');
  console.log('  target: ' + r.target_count);
  console.log('  would send: ' + r.sent);
  console.log('  duration: ' + r.duration_ms + 'ms');
}).catch(e => console.log('ERR:', e.message));
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:800])
client.close()
