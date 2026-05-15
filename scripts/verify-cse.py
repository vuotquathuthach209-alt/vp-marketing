"""Save CSE ID + verify "Search the entire web" mode."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/cse-test.js <<'EOF'
(async () => {
  const { db, setSetting, getSetting } = require('/opt/vp-marketing/dist/db');
  const { checkKeywordRank } = require('/opt/vp-marketing/dist/services/seo/keyword-tracker');

  console.log('=== STEP 1: Save CSE ID ===');
  setSetting('google_cse_id', '45e45e6ba242f487e');
  console.log('Saved: google_cse_id = ' + getSetting('google_cse_id'));
  console.log('API key:                ' + (getSetting('google_cse_api_key') || getSetting('google_api_key') || 'MISSING').slice(0,12) + '...');

  console.log('\n=== STEP 2: Test BRANDED keyword "sondervn" ===');
  console.log('(Expected: rank ~1-10 since brand search)');
  const t0 = Date.now();
  const r1 = await checkKeywordRank('sondervn', 'https://sondervn.com');
  console.log('Rank: ' + (r1.rank ? '#' + r1.rank : 'not in top 50'));
  console.log('Source: ' + r1.source);
  console.log('Total results: ' + (r1.total_results || 'n/a'));
  console.log('Cost: $' + (r1.cost_usd || 0).toFixed(4));
  console.log('Duration: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
  if (r1.error) console.log('❌ ERROR: ' + r1.error);

  console.log('\n=== STEP 3: Test HEAD TERM "khách sạn đà lạt" ===');
  console.log('(Critical test: if total_results > 100k → CSE đang search entire web. If <1k → chỉ search sondervn.com)');
  const t1 = Date.now();
  const r2 = await checkKeywordRank('khách sạn đà lạt', 'https://sondervn.com');
  console.log('Rank: ' + (r2.rank ? '#' + r2.rank : 'not in top 50 — bình thường cho head term'));
  console.log('Total results: ' + (r2.total_results || 'n/a'));
  console.log('Duration: ' + ((Date.now()-t1)/1000).toFixed(1) + 's');
  if (r2.error) console.log('❌ ERROR: ' + r2.error);

  console.log('\n=== VERDICT ===');
  if (r2.error) {
    console.log('❌ Không lấy được kết quả — kiểm tra API key có quyền "Custom Search API" trong Google Cloud Console');
  } else if (!r2.total_results || r2.total_results < 1000) {
    console.log('⚠️ Total results < 1000 cho head term phổ biến → CSE chưa bật "Search the entire web"');
    console.log('   → Anh quay lại trang quản lý CSE → bật toggle này → bấm Update');
  } else {
    console.log('✅ CSE đang search ENTIRE WEB (total_results = ' + r2.total_results + ' cho "khách sạn đà lạt")');
    console.log('   → Tool sẵn sàng track 42 keywords');
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.message); process.exit(1); });
EOF
cd /opt/vp-marketing && node /tmp/cse-test.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=90)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()
