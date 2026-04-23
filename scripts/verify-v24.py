"""Verify v24 deploy: sanitizer + vn-date-formatter + ttl + batched ask."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. v24 files compiled? ==="
ls -la dist/services/message-sanitizer.js dist/services/vn-date-formatter.js 2>&1

echo ""
echo "=== 2. Sanitizer smoke test ==="
cat > /tmp/v24test.js <<'JS'
const { stripMarkdown, sanitizeForZalo } = require('/opt/vp-marketing/dist/services/message-sanitizer');

const cases = [
  ['giá **550k/đêm**', 'giá 550k/đêm'],
  ['🏡 **Homestay** (2 chỗ)', '🏡 Homestay (2 chỗ)'],
  ['gõ `đặt phòng` nhé', 'gõ đặt phòng nhé'],
  ['- Item A\n- Item B', '• Item A\n• Item B'],
];
let pass = 0, fail = 0;
for (const [input, want] of cases) {
  const got = stripMarkdown(input);
  if (got === want) { pass++; console.log('  ✅ ' + input.slice(0,30)); }
  else { fail++; console.log('  ❌ got=' + got + ' want=' + want); }
}
console.log('Sanitizer: ' + pass + '/' + (pass+fail) + ' pass');
JS
node /tmp/v24test.js 2>&1

echo ""
echo "=== 3. VN date formatter ==="
cat > /tmp/v24date.js <<'JS'
const { formatDateVNDisplay } = require('/opt/vp-marketing/dist/services/vn-date-formatter');
const today = new Date().toISOString().slice(0,10);
const d1 = new Date(); d1.setDate(d1.getDate()+1);
const tomorrow = d1.toISOString().slice(0,10);
console.log('  today (' + today + '):', formatDateVNDisplay(today));
console.log('  tomorrow (' + tomorrow + '):', formatDateVNDisplay(tomorrow));
console.log('  ISO 2026-05-02:', formatDateVNDisplay('2026-05-02'));
JS
node /tmp/v24date.js 2>&1

echo ""
echo "=== 4. FSM session TTL in place? ==="
grep -c 'SESSION_TTL_MS\|TERMINAL_TTL_MS' dist/services/conversation-fsm.js

echo ""
echo "=== 5. Generic availability patched? ==="
grep -c 'currentSlots' dist/services/funnel-dispatcher.js

echo ""
echo "=== 6. Recent convos ==="
cat > /tmp/v24conv.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare("SELECT sender_id, stage, slots, datetime(updated_at/1000, 'unixepoch', '+7 hours') as updated_vn FROM bot_conversation_state ORDER BY updated_at DESC LIMIT 5").all();
console.log('Recent FSM states:');
rows.forEach(r => console.log('  ' + r.sender_id + ' stage=' + r.stage + ' updated=' + r.updated_vn));
db.close();
JS
node /tmp/v24conv.js 2>&1

rm -f /tmp/v24test.js /tmp/v24date.js /tmp/v24conv.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()
