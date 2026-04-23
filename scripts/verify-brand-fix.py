"""Verify brand positioning fix — check actual DB content."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_verify.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== reply_templates variant C (greeting_new) ===');
const tmpl = db.prepare(`SELECT id, content FROM reply_templates WHERE template_key = 'greeting_new' AND variant_name = 'C'`).get();
if (!tmpl) { console.log('NOT FOUND'); }
else {
  console.log('id=' + tmpl.id);
  console.log('Content snippet:', tmpl.content.substring(0, 200));
  const hasOld = tmpl.content.includes('chuỗi 7') || tmpl.content.includes('chuỗi khách sạn');
  const hasNew = tmpl.content.includes('hệ thống tư vấn') || tmpl.content.includes('tư vấn phòng lưu trú');
  console.log('Has OLD wording ("chuỗi 7"):', hasOld, '(expect false)');
  console.log('Has NEW wording ("hệ thống tư vấn"):', hasNew, '(expect true)');
}

console.log('\n=== wiki sonder-brand ===');
const brand = db.prepare(`SELECT content FROM knowledge_wiki WHERE slug = 'sonder-brand' LIMIT 1`).get();
if (!brand) console.log('NOT FOUND');
else {
  const hasOld = brand.content.includes('chuỗi khách sạn boutique');
  const hasNew = brand.content.includes('HỆ THỐNG TƯ VẤN');
  console.log('Has OLD "chuỗi khách sạn boutique":', hasOld, '(expect false)');
  console.log('Has NEW "HỆ THỐNG TƯ VẤN":', hasNew, '(expect true)');
}

console.log('\n=== wiki customer-care-tone ===');
const tone = db.prepare(`SELECT content FROM knowledge_wiki WHERE slug = 'customer-care-tone' LIMIT 1`).get();
if (!tone) console.log('NOT FOUND');
else {
  const hasOld = tone.content.includes('"mình" (bot)');
  const hasNew = tone.content.includes('TUYỆT ĐỐI KHÔNG DÙNG');
  console.log('Has OLD "mình (bot)":', hasOld, '(expect false)');
  console.log('Has NEW strict persona:', hasNew, '(expect true)');
}

console.log('\n=== All "chuỗi" mentions in DB (reply_templates + wiki) ===');
const chuoi = db.prepare(`SELECT 'template' as type, id, variant_name as slug, substr(content, 1, 100) as snippet FROM reply_templates WHERE content LIKE '%chuỗi%' UNION ALL SELECT 'wiki' as type, id, slug, substr(content, 1, 100) as snippet FROM knowledge_wiki WHERE content LIKE '%chuỗi%'`).all();
console.log('Found', chuoi.length, 'rows still mentioning "chuỗi":');
chuoi.forEach(r => console.log('  [' + r.type + '] #' + r.id + ' ' + r.slug + ': ' + r.snippet.substring(0, 80)));

db.close();
JS

node tmp_verify.js
rm -f tmp_verify.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()
