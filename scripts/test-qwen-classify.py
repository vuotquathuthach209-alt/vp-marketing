"""Test Qwen classifier live: check Ollama + trigger batch + verify classified."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
echo '=== 1. Ollama status ==='
systemctl is-active ollama 2>&1 || echo 'not running'
curl -s http://127.0.0.1:11434/api/tags 2>&1 | head -c 500
echo
echo

echo '=== 2. Current pending records ==='
cat > tmp-check.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const h = db.prepare("SELECT COUNT(*) as n FROM ota_raw_hotels WHERE status='pending'").get();
const r = db.prepare("SELECT COUNT(*) as n FROM ota_raw_rooms WHERE status='pending'").get();
const a = db.prepare("SELECT COUNT(*) as n FROM ota_raw_availability WHERE status='pending'").get();
console.log(`pending: hotels=${h.n}, rooms=${r.n}, availability=${a.n}`);
console.log('');
console.log('=== Sample pending hotel ===');
const sample = db.prepare("SELECT id, ota_id, substr(payload, 1, 300) as preview FROM ota_raw_hotels WHERE status='pending' LIMIT 1").get();
if (sample) console.log(JSON.stringify(sample, null, 2));
else console.log('(none)');
db.close();
JS
node tmp-check.js
rm -f tmp-check.js

echo
echo '=== 3. Trigger Qwen classifier manually ==='
cat > tmp-run.js <<'JS'
(async () => {
  try {
    const { runQwenClassifierBatch } = require('./dist/services/qwen-classifier');
    const t0 = Date.now();
    const stats = await runQwenClassifierBatch();
    console.log('Result:', JSON.stringify(stats, null, 2));
    console.log(`Total time: ${Date.now() - t0}ms`);
  } catch (e) {
    console.log('ERR:', e.message);
    console.log(e.stack);
  }
})();
JS
node tmp-run.js
rm -f tmp-run.js

echo
echo '=== 4. Verify hotel_profile updated ==='
cat > tmp-verify.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`
  SELECT hp.hotel_id, hp.name_canonical, hp.property_type, hp.rental_type, hp.product_group, hp.city, hp.district, hp.data_source
  FROM hotel_profile hp ORDER BY hotel_id DESC LIMIT 5
`).all();
rows.forEach(r => console.log(`  #${r.hotel_id} ${r.name_canonical} | ${r.property_type}/${r.rental_type}/${r.product_group} | ${r.district || '-'}, ${r.city || '-'} | source=${r.data_source}`));
console.log('');
console.log('=== property_types_discovered ===');
const pts = db.prepare(`SELECT raw_type_name, mapped_to, occurrences FROM property_types_discovered ORDER BY created_at DESC`).all();
if (!pts.length) console.log('  (none)');
else pts.forEach(p => console.log(`  "${p.raw_type_name}" → ${p.mapped_to || 'unmapped'} (×${p.occurrences})`));
console.log('');
console.log('=== batches summary ===');
const batches = db.prepare(`SELECT batch_id, type, total_items, classified_items, failed_items, pending_items FROM ota_raw_batches ORDER BY received_at DESC LIMIT 5`).all();
batches.forEach(b => console.log(`  ${b.batch_id} [${b.type}]: ${b.classified_items}/${b.total_items} classified, ${b.failed_items} failed, ${b.pending_items} pending`));
db.close();
JS
node tmp-verify.js
rm -f tmp-verify.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
