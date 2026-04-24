"""Test OTA API directly to see what data is available."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
(async () => {
  const { listAllHotels } = require('/opt/vp-marketing/dist/services/ota-api-client');
  try {
    const all = await listAllHotels({ maxPages: 5 });
    console.log('Total hotels from OTA API:', all.length);
    all.forEach((h, i) => {
      console.log(`\n[${i+1}] id=${h.id} name=${h.name}`);
      console.log('  coverImage:', h.coverImage ? h.coverImage.slice(0, 80) : 'null');
      console.log('  images count:', h.images?.length || 0);
      if (h.images?.length) console.log('  first image:', String(h.images[0]).slice(0, 80));
      console.log('  rooms count:', h.rooms?.length || 0);
    });
  } catch (e) {
    console.log('ERROR:', e.message);
  }
})();
JS
node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, err = c.exec_command(CMD, timeout=90)
print(out.read().decode('utf-8'))
e = err.read().decode('utf-8')
if e.strip(): print('STDERR:', e[:500])
c.close()
