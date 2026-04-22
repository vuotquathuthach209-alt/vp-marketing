"""Verify auto-wiki generation sau fix."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# Trigger rebuild all
cat > tmp.js <<'JS'
(async () => {
  const { rebuildAllEmbeddings } = require('./dist/services/knowledge-sync');
  const r = await rebuildAllEmbeddings();
  console.log(JSON.stringify(r, null, 2));
})();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Auto-generated Wiki entries (filtered by auto slugs) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const wiki = db.prepare(`SELECT namespace, slug, title, substr(content, 1, 200) as preview FROM knowledge_wiki
  WHERE slug LIKE 'hotel-%' OR slug LIKE 'area-%' OR slug LIKE 'promo-hotel-%' OR slug LIKE 'rules-hotel-%' OR slug LIKE 'reviews-hotel-%'
  ORDER BY namespace, slug`).all();
if (wiki.length === 0) console.log('(none)');
else wiki.forEach(w => {
  console.log(`[${w.namespace}] ${w.slug}`);
  console.log(`  Title: ${w.title}`);
  console.log(`  Preview: ${w.preview.replace(/\n/g, ' ').slice(0, 150)}...`);
  console.log('');
});

console.log(`=== ALL wiki by namespace ===`);
const byNs = db.prepare(`SELECT namespace, COUNT(*) as n FROM knowledge_wiki WHERE active = 1 GROUP BY namespace ORDER BY n DESC`).all();
byNs.forEach(r => console.log(`  ${r.namespace}: ${r.n}`));

console.log(`\n=== Total chunks all hotels ===`);
const chunks = db.prepare(`SELECT chunk_type, COUNT(*) as n FROM hotel_knowledge_embeddings GROUP BY chunk_type ORDER BY n DESC`).all();
chunks.forEach(r => console.log(`  ${r.chunk_type}: ${r.n}`));

db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()
