"""Test bot với khách đi thẳng vào vấn đề — không chào hỏi."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

SCENARIOS = [
    ("direct_1", "Giá phòng bao nhiêu", "Price question — no context"),
    ("direct_2", "Còn phòng trống 25/5 không", "Availability check"),
    ("direct_3", "Đặt phòng Seehome 2 người tối nay", "Direct booking intent"),
    ("direct_4", "Cho mình xem ảnh phòng", "Image request"),
    ("direct_5", "Check-in mấy giờ", "Policy question"),
    ("direct_6", "0909123456 Nguyễn Văn A", "Phone + name only"),
    ("direct_7", "Seehome Airport", "Property name only"),
    ("direct_8", "Tôi muốn book homestay ngày mai 2 người", "Full booking 1 shot"),
    ("direct_9", "Giá rẻ nhất bao nhiêu", "Cheapest price"),
    ("direct_10", "Có wifi không", "Amenity single"),
]

CMD_TMPL = r"""
cd /opt/vp-marketing
# Clean
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const senders = ###SENDER_LIST###;
senders.forEach(sid => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(sid);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(sid);
});
db.close();
console.log('cleaned');
JS
node tmp.js
rm -f tmp.js

###SCENARIOS###

echo ""
echo "=== RESULTS ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const senders = ###SENDER_LIST###;
for (const sid of senders) {
  console.log('');
  console.log('━━━ ' + sid + ' ━━━');
  const rows = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = ? ORDER BY id ASC`).all(sid);
  rows.forEach(r => {
    const icon = r.role === 'user' ? '👤' : '🤖';
    console.log(icon + ' [' + (r.intent || '-') + ']');
    console.log('   ' + r.msg.replace(/\n/g, ' '));
  });
}
db.close();
JS
node tmp.js
rm -f tmp.js
"""

senders = [f'zalo:{s[0]}' for s in SCENARIOS]
sender_list = '[' + ', '.join(f"'{s}'" for s in senders) + ']'

test_steps = []
for (sid, msg, desc) in SCENARIOS:
    escaped = msg.replace('"', '\\"')
    test_steps.append(f'''
echo ""
echo "━━━ [{desc}] USER: {msg} ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \\
  -H 'Content-Type: application/json' \\
  -d '{{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{{"id":"{sid}"}},"message":{{"text":"{escaped}"}}}}' > /dev/null
sleep 6
''')

cmd = CMD_TMPL.replace('###SENDER_LIST###', sender_list).replace('###SCENARIOS###', '\n'.join(test_steps))

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(cmd, timeout=300)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
