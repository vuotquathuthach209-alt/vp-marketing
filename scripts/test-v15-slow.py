"""Test v15 routing with longer sleep."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

SCENARIOS = [
    ("Chính sách hủy phòng thế nào",   "policy_cancellation"),
    ("Check-in sớm được không",        "policy_early_checkin"),
    ("Có mã khuyến mãi không",         "promo_list"),
    ("Cuối tuần có đắt hơn không",     "pricing_rules_list"),
    ("Ở 14 đêm có giảm không",         "pricing_rules_list"),
    ("Lễ 30/4 giá thế nào",            "pricing_rules_list"),
    ("Khách VIP có ưu đãi gì",         "policy_vip_discount"),
]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)

results = []
for i, (msg, expected_intent) in enumerate(SCENARIOS):
    sender = f"v15_slow_{i}"
    # Clean
    clean = f"""
cat > /tmp/c.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('/opt/vp-marketing/data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:{sender}'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:{sender}'`).run();
db.close();
JS
node /tmp/c.js; rm -f /tmp/c.js
"""
    send = f'curl -s -X POST http://127.0.0.1:3000/webhook/zalo -H "Content-Type: application/json" -d \'{{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{{"id":"{sender}"}},"message":{{"text":"{msg}"}}}}\' > /dev/null'
    check = f"""
cat > /tmp/c.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('/opt/vp-marketing/data/db.sqlite');
const r = db.prepare(`SELECT role, substr(message, 1, 250) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:{sender}' ORDER BY id`).all();
r.forEach(x => console.log((x.role === 'user' ? '👤' : '🤖') + ' [' + (x.intent||'-') + '] ' + x.msg));
db.close();
JS
node /tmp/c.js; rm -f /tmp/c.js
"""

    # Execute
    _, _, _ = client.exec_command(clean, timeout=10)
    time.sleep(1)
    _, _, _ = client.exec_command(send, timeout=10)
    time.sleep(8)   # wait for bot
    _, stdout, _ = client.exec_command(check, timeout=10)
    out = stdout.read().decode('utf-8', errors='replace')
    print(f"\n--- [{i+1}] USER: {msg} (expect {expected_intent}) ---")
    print(out.strip())
    # Extract intent
    got_intent = None
    for line in out.split('\n'):
        if '🤖' in line and '[' in line:
            start = line.find('[') + 1
            end = line.find(']')
            if end > start:
                got_intent = line[start:end]
                break
    match = '✅' if got_intent == expected_intent else '❌'
    results.append((msg, expected_intent, got_intent, match))

client.close()

print("\n\n=== SUMMARY ===")
for msg, exp, got, m in results:
    print(f"{m} [{got or 'NONE'}] expected [{exp}] — {msg}")
passed = sum(1 for _,_,_,m in results if m == '✅')
print(f"\n{passed}/{len(results)} PASS")
