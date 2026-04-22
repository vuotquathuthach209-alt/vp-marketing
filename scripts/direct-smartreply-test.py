"""Gọi smartReplyWithSender trực tiếp để debug."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp-direct.js <<'JS'
(async () => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database('data/db.sqlite');
    db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:direct_smart'`).run();
    db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:direct_smart'`).run();
    db.close();

    const { smartReplyWithSender } = require('./dist/services/smartreply');
    const t0 = Date.now();
    console.log('Calling smartReplyWithSender("Giá phòng bao nhiêu", ...)');
    const result = await smartReplyWithSender('Giá phòng bao nhiêu', 'zalo:direct_smart', undefined, false, 1, 0);
    console.log('Elapsed:', Date.now() - t0, 'ms');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERR:', e.message);
    console.log(e.stack);
  }
})();
JS
node tmp-direct.js
rm -f tmp-direct.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
