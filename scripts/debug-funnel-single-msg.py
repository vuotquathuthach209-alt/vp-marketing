"""Trigger single message + tail logs để debug."""
import sys, os, paramiko, time, threading
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing

# Set state to SHOW_RESULTS with shown_property_ids for test user
cat > tmp-seed.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();
const slots = JSON.stringify({
  property_type: 'homestay',
  rental_mode: 'short_term',
  shown_property_ids: [7],
  guests_adults: 2,
  budget_max: 1000000,
  area_normalized: 'Tân Bình',
  city: 'Ho Chi Minh',
});
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:debug_pick'`).run();
db.prepare(`INSERT INTO bot_conversation_state
  (sender_id, hotel_id, stage, slots, turns_since_extract, turn_count, language, handed_off, created_at, updated_at)
  VALUES ('zalo:debug_pick', 1, 'SHOW_RESULTS', ?, 0, 1, 'vi', 0, ?, ?)`).run(slots, now, now);
console.log('Seeded state = SHOW_RESULTS, shown_property_ids=[7]');
db.close();
JS
node tmp-seed.js
rm -f tmp-seed.js

# Tail logs in background + send message
timeout 25 pm2 logs vp-mkt --raw --lines 0 2>&1 | grep -iE '\[funnel\]|smartreply.*error|Error' &
TAIL_PID=$!

sleep 1

echo "=== Sending 'lấy số 1' ==="
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"debug_pick"},"message":{"text":"lấy số 1"}}'
echo
sleep 3

echo
echo "=== Final state ==="
cat > tmp-check.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const s = db.prepare(`SELECT stage, slots FROM bot_conversation_state WHERE sender_id = 'zalo:debug_pick'`).get();
if (s) {
  console.log('Stage:', s.stage);
  console.log('Slots:', JSON.stringify(JSON.parse(s.slots), null, 2));
}
db.close();
JS
node tmp-check.js
rm -f tmp-check.js

wait $TAIL_PID 2>/dev/null
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
for line in iter(stdout.readline, ""):
    if line.strip(): print(line, end="", flush=True)
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("\nSTDERR:\n" + err, file=sys.stderr)
client.close()
