"""Sinh 5 bai SEO long-tail uu tien cao cho Sondervn."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

# 5 keyword long-tail uu tien cao (skip 1 bài đã sinh là "khách sạn Q1 dưới 500k")
TARGETS = [
    {"keyword": "khách sạn bùi viện giá rẻ có máy lạnh", "angle": "local_insider"},
    {"keyword": "homestay cô giang quận 1 gia đình", "angle": "local_insider"},
    {"keyword": "khách sạn phạm ngũ lão sài gòn dưới 400k", "angle": "destination_guide"},
    {"keyword": "homestay đà lạt view đồi giá rẻ", "angle": "destination_guide"},
    {"keyword": "khách sạn đà nẵng gần biển mỹ khê", "angle": "destination_guide"},
]

SCRIPT_TEMPLATE = r"""
cat > /tmp/batch.js <<'EOF'
(async () => {
  const { db } = require('/opt/vp-marketing/dist/db');
  const { generateArticle, saveArticle } = require('/opt/vp-marketing/dist/services/seo/article-writer');

  const targets = TARGETS_PLACEHOLDER;
  let ok = 0, fail = 0;
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    console.log('\n[' + (i+1) + '/' + targets.length + '] "' + tgt.keyword + '" (' + tgt.angle + ')');
    const ts = Date.now();
    try {
      const draft = await generateArticle({
        keyword_target: tgt.keyword,
        angle: tgt.angle,
        language: 'vi',
        target_word_count: 1500,
      });
      if (!draft) {
        console.log('  ❌ generation returned null');
        fail++;
        continue;
      }
      const id = saveArticle(draft, { angle: tgt.angle });
      console.log('  ✅ #' + id + ' | ' + draft.word_count + 'w | FAQ ' + (draft.faq?.length||0) + ' | ' + ((Date.now()-ts)/1000).toFixed(1) + 's');
      console.log('     Title: ' + draft.title);
      ok++;
    } catch (e) {
      console.log('  ❌ ERROR: ' + e.message);
      fail++;
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log('OK:    ' + ok + '/' + targets.length);
  console.log('Fail:  ' + fail);
  console.log('Total time: ' + ((Date.now()-t0)/1000).toFixed(0) + 's (~' + ((Date.now()-t0)/60000).toFixed(1) + ' min)');
  console.log('Cost estimate: ~$' + (ok * 0.02).toFixed(3));

  console.log('\n=== All articles in library ===');
  const list = db.prepare(`SELECT id, title, word_count, status FROM seo_articles ORDER BY id DESC LIMIT 20`).all();
  for (const a of list) {
    console.log('  #' + a.id + ' [' + a.status + '] ' + a.word_count + 'w | ' + a.title.slice(0, 60));
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.message); process.exit(1); });
EOF
cd /opt/vp-marketing && node /tmp/batch.js
"""

import json
SCRIPT = SCRIPT_TEMPLATE.replace("TARGETS_PLACEHOLDER", json.dumps(TARGETS, ensure_ascii=False))

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
print(f"Sinh {len(TARGETS)} bài SEO trên VPS — ước tính ~10 phút...", flush=True)
_, o, e = cl.exec_command(SCRIPT, timeout=900)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()
