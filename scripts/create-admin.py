"""Create / reset superadmin account."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
ADMIN_EMAIL = sys.argv[2] if len(sys.argv) > 2 else "admin@sonder.vn"
ADMIN_PASS = sys.argv[3] if len(sys.argv) > 3 else "Sonder@2026"

CMD = f"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_create_admin.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('data/db.sqlite');

const EMAIL = '{ADMIN_EMAIL}';
const PASS = '{ADMIN_PASS}';

(async () => {{
  const hash = await bcrypt.hash(PASS, 10);

  // Check if user exists
  const existing = db.prepare('SELECT id, email FROM mkt_users WHERE email = ?').get(EMAIL);

  if (existing) {{
    // Update password + upgrade role to superadmin
    db.prepare(`UPDATE mkt_users SET password_hash = ?, role = 'superadmin', status = 'active', signup_source = 'self', updated_at = ? WHERE email = ?`)
      .run(hash, Date.now(), EMAIL);
    console.log('✅ Updated existing account: ' + EMAIL);
    console.log('   Role: superadmin, password reset');
  }} else {{
    // Need a hotel row (mkt_hotels) first — use hotel 1 (or create)
    let hotelId = 1;
    const hotel = db.prepare('SELECT id FROM mkt_hotels WHERE id = 1').get();
    if (!hotel) {{
      // Create a default hotel
      const now = Date.now();
      const r = db.prepare(`INSERT INTO mkt_hotels (id, name, plan, status, trial_ends_at, plan_expires_at, created_at, updated_at) VALUES (1, 'Sonder Admin Hotel', 'pro', 'active', ?, ?, ?, ?)`)
        .run(now + 365*86400000, now + 365*86400000, now, now);
      hotelId = r.lastInsertRowid;
      console.log('Created default mkt_hotels id=' + hotelId);
    }}

    const now = Date.now();
    db.prepare(`
      INSERT INTO mkt_users (email, hotel_id, role, display_name, password_hash, signup_source, status, created_at, updated_at)
      VALUES (?, ?, 'superadmin', 'Admin Sonder', ?, 'self', 'active', ?, ?)
    `).run(EMAIL, hotelId, hash, now, now);
    console.log('✅ Created new superadmin account');
  }}

  console.log('\\n═══════════════════════════════════════════');
  console.log('  EMAIL:    ' + EMAIL);
  console.log('  PASSWORD: ' + PASS);
  console.log('  ROLE:     superadmin');
  console.log('  URL:      https://103.82.193.74/');
  console.log('═══════════════════════════════════════════');
  console.log('\\nĐăng nhập tại: https://103.82.193.74/ (hoặc http://)');
  console.log('Sau khi login → sidebar "Tạo video & Đăng" sẽ hiện.');

  db.close();
}})().catch(e => {{ console.error('Error:', e.message); process.exit(1); }});
JS

node /opt/vp-marketing/_tmp_create_admin.js
rm /opt/vp-marketing/_tmp_create_admin.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:800])
c.close()
