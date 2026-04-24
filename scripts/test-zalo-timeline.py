"""Test Zalo timeline article creation (no broadcast)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_test.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const {
  getZaloByOaId,
  zaloCreateTimelineArticle,
  textToZaloBodyBlocks,
} = require('/opt/vp-marketing/dist/services/zalo');
const db = new Database('data/db.sqlite');

(async () => {
  const oaRow = db.prepare(`SELECT oa_id FROM zalo_oa WHERE enabled = 1 LIMIT 1`).get();
  const oa = getZaloByOaId(oaRow.oa_id);
  console.log('OA:', oa.oa_name);

  // Use a reliable public image for testing
  const coverUrl = 'https://picsum.photos/1200/630';
  const title = 'Test Sonder Timeline Post';
  const description = 'Đây là test bài timeline (không broadcast inbox).';
  const bodyBlocks = textToZaloBodyBlocks(
    'Dạ bên em vừa test chức năng đăng bài lên timeline OA Sonder.\n\n' +
    'Tin này hiển thị trên FEED của OA. Follower không nhận push notification.\n\n' +
    'Nếu anh/chị thấy bài này trong Zalo OA page → test thành công ✅'
  );

  console.log('\n=== Test POST /v2.0/article/create ===');
  try {
    const result = await zaloCreateTimelineArticle(oa, {
      title, description, cover: coverUrl, bodyBlocks,
      status: 'show', comment: 'enable',
    });
    console.log('\n✅ ARTICLE CREATED');
    console.log('  article_id:', result.article_id);
    console.log('  url:', result.url);
    console.log('  Raw:', JSON.stringify(result.raw).substring(0, 400));
  } catch (e) {
    console.log('\n❌ FAIL');
    console.log('  Status:', e.response?.status);
    console.log('  Data:', JSON.stringify(e.response?.data).substring(0, 500));
    console.log('  Message:', e.message);
  }

  db.close();
})();
JS

node tmp_test.js
rm -f tmp_test.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()
