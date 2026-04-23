"""Cleanup test data sau khi verify."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const senders = ['fb_v13_test', 'zalo:v13_test', 'zalo:direct_smart', 'zalo:broad_test', 'zalo:r5_debug', 'zalo:d1_debug'];
for (const s of senders) {
  const dm = db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  const cm = db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
  const bro = db.prepare(`DELETE FROM bot_reply_outcomes WHERE sender_id = ?`).run(s);
  const fst = db.prepare(`DELETE FROM funnel_stage_transitions WHERE sender_id = ?`).run(s);
  const cc = db.prepare(`DELETE FROM customer_contacts WHERE sender_id = ?`).run(s);
  if (dm.changes || cm.changes || bro.changes || fst.changes || cc.changes) {
    console.log(s + ': state=' + dm.changes + ' msgs=' + cm.changes + ' outcomes=' + bro.changes + ' transitions=' + fst.changes + ' contacts=' + cc.changes);
  }
}
// Also test contacts from direct questions test
const direct = db.prepare(`DELETE FROM customer_contacts WHERE sender_id LIKE 'zalo:direct_%'`).run();
console.log('direct_* contacts deleted:', direct.changes);
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Post-cleanup feedback loop state (real traffic only) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const cnt = db.prepare(`SELECT outcome, COUNT(*) as n FROM bot_reply_outcomes GROUP BY outcome`).all();
console.log('bot_reply_outcomes by outcome:');
cnt.forEach(c => console.log('  ' + c.outcome + ': ' + c.n));
const trans = db.prepare(`SELECT COUNT(*) as n FROM funnel_stage_transitions`).get();
console.log('funnel_stage_transitions:', trans.n);
db.close();
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
