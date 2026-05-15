"""Test CMS push skill on VPS — verify schema + dry-run + safety."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/test-cms.js <<'EOF'
(async () => {
  const { db, setSetting, getSetting } = require('/opt/vp-marketing/dist/db');
  const {
    pushArticleToCMS, healthCheckCMS, getCmsConfig, updateCmsConfig
  } = require('/opt/vp-marketing/dist/services/seo/article-publisher');

  console.log('═══ STEP 1: Verify schema (CMS columns) ═══');
  const cols = db.prepare(`PRAGMA table_info(seo_articles)`).all();
  const cmsCols = cols.filter(c => c.name.startsWith('cms_'));
  console.log('CMS columns added: ' + cmsCols.length);
  for (const c of cmsCols) console.log('  ' + c.name.padEnd(25) + ' ' + c.type);

  console.log('\n═══ STEP 2: Verify config defaults (dry-run = true by default) ═══');
  const cfg = getCmsConfig();
  console.log(JSON.stringify(cfg, null, 2));

  console.log('\n═══ STEP 3: Set fake config + DRY-RUN push article #1 ═══');
  updateCmsConfig({
    url: 'https://sondervn.com',
    api_path: '/api/admin/articles',
    token: 'FAKE_TOKEN_FOR_DRY_RUN_TEST',
    dry_run: true,
    max_per_minute: 5,
  });
  console.log('Config saved.');

  const r1 = await pushArticleToCMS(1);
  console.log('\nPush #1 result:');
  console.log('  ok:           ' + r1.ok);
  console.log('  status:       ' + r1.status);
  console.log('  dry_run:      ' + r1.dry_run);
  console.log('  duration_ms:  ' + r1.duration_ms);
  if (r1.error) console.log('  error:        ' + r1.error);

  console.log('\n═══ STEP 4: Verify audit log entry ═══');
  const audit = db.prepare(`SELECT * FROM prepublish_audit WHERE source = 'cms_push' ORDER BY checked_at DESC LIMIT 3`).all();
  console.log('Audit entries: ' + audit.length);
  for (const a of audit) {
    console.log('  ' + a.decision.padEnd(20) + ' src_id=' + a.source_id + ' blocked=' + a.blocked + ' (' + a.duration_ms + 'ms)');
  }

  console.log('\n═══ STEP 5: Test idempotency — push #1 lại ═══');
  // First, simulate a previous successful push
  db.prepare(`UPDATE seo_articles SET cms_id = 'fake-cms-id-99', cms_status = 'pushed_draft', cms_pushed_at = ? WHERE id = 1`).run(Date.now());
  const r2 = await pushArticleToCMS(1);
  console.log('Push #1 again (should skip):');
  console.log('  status:  ' + r2.status);
  console.log('  cms_id:  ' + r2.cms_id);
  if (r2.status !== 'skipped_duplicate') console.log('  ⚠️ Expected skipped_duplicate!');
  else console.log('  ✅ Correctly skipped duplicate');

  // Reset state for clean test
  db.prepare(`UPDATE seo_articles SET cms_id = NULL, cms_status = NULL, cms_pushed_at = NULL WHERE id = 1`).run();

  console.log('\n═══ STEP 6: Test health check (will fail — URL fake) ═══');
  const h = await healthCheckCMS();
  console.log('Health check:');
  console.log('  ok:           ' + h.ok);
  console.log('  status:       ' + h.status);
  console.log('  error:        ' + (h.error || '(none)'));
  console.log('  duration_ms:  ' + h.duration_ms);

  console.log('\n═══ STEP 7: Verify articles list now includes cms_* fields ═══');
  const arts = db.prepare(`SELECT id, title, cms_status, cms_id FROM seo_articles ORDER BY id LIMIT 6`).all();
  for (const a of arts) {
    console.log('  #' + a.id + ' [' + (a.cms_status || 'unpublished').padEnd(15) + '] ' + a.title.slice(0, 60));
  }

  console.log('\n═══ DONE ═══');
  console.log('Skill ready. Khi anh deploy endpoint trên sondervn.com:');
  console.log('  1. Vào /admin/seo/dashboard → tab Articles');
  console.log('  2. Click ⚙️ Config → paste URL + token + tắt DRY-RUN');
  console.log('  3. Click 🧪 Health check → confirm OK');
  console.log('  4. Click 📤 Push CMS trên 1 bài → kiểm tra bài vào CMS');

  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.message); process.exit(1); });
EOF
cd /opt/vp-marketing && node /tmp/test-cms.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=120)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()
