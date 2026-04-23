"""Verify v23 deploy: intent_logs table + greeting-gate service loaded."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. intent_logs table structure ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
try {
  const cols = db.prepare("PRAGMA table_info(intent_logs)").all();
  console.log('intent_logs columns:', cols.length);
  cols.forEach(c => console.log('  ' + c.cid + ' ' + c.name + ' ' + c.type));

  const n = db.prepare('SELECT COUNT(*) as n FROM intent_logs').get();
  console.log('intent_logs rows:', n.n);

  const recent = db.prepare('SELECT primary_intent, sub_category, routed_to, created_at FROM intent_logs ORDER BY id DESC LIMIT 5').all();
  console.log('Recent 5:');
  recent.forEach(r => console.log('  ' + new Date(r.created_at).toISOString() + ' ' + r.primary_intent + '/' + (r.sub_category||'-') + ' -> ' + (r.routed_to||'-')));
} catch (e) { console.log('ERR:', e.message); }
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Check files deployed ==="
ls -la dist/services/greeting-gate.js dist/services/intent-logger.js 2>&1 | head -10

echo ""
echo "=== 3. PM2 status ==="
pm2 list | grep vp-mkt

echo ""
echo "=== 4. Startup log (new) ==="
pm2 logs vp-mkt --lines 50 --nostream 2>&1 | grep -iE 'intent_logs|greeting|v23|error|fail' | tail -20

echo ""
echo "=== 5. Run quick greeting-gate smoke test ==="
cat > tmp-test.js <<'JS'
const { shouldSendGreeting, hasRecentBotActivity } = require('./dist/services/greeting-gate');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Test 1: brand new sender → should send greeting
const r1 = shouldSendGreeting('test:fresh_user_xyz', 'Chào anh/chị! 👋 Em là trợ lý Sonder');
console.log('Fresh sender → shouldSend:', r1, '(expect: true)');

// Test 2: pretend sender already got greeting recently — insert fake record
db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, 'bot', ?, ?)`)
  .run('test:dup_user_xyz', 'Chào anh/chị! 👋 Em là trợ lý Sonder — nền tảng đặt phòng trực tuyến.', Date.now());
const r2 = shouldSendGreeting('test:dup_user_xyz', 'Chào anh/chị! 👋 Em là trợ lý Sonder');
console.log('Just-greeted sender → shouldSend:', r2, '(expect: false)');

// Clean up
db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'test:%'`).run();
db.close();
JS
node tmp-test.js 2>&1; rm -f tmp-test.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()
