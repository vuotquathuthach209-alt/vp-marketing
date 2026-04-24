"""Force re-seed to apply first_contact_warm trim (trigger now just turn_number=1)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_reseed.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== Before force re-seed ===');
const before = db.prepare(`SELECT id, trigger_conditions FROM agentic_templates WHERE id IN ('first_contact_warm', 'first_vague')`).all();
for (const r of before) console.log(`  ${r.id}: ${r.trigger_conditions}`);

const { seedTemplates, DEFAULT_TEMPLATES } = require('/opt/vp-marketing/dist/services/agentic/template-seeder');
console.log(`\nForce re-seeding ${DEFAULT_TEMPLATES.length} templates...`);
const r = seedTemplates(true);  // force=true overwrites existing
console.log(`  inserted=${r.inserted} skipped=${r.skipped}`);

console.log('\n=== After force re-seed ===');
const after = db.prepare(`SELECT id, trigger_conditions FROM agentic_templates WHERE id IN ('first_contact_warm', 'first_vague')`).all();
for (const r of after) console.log(`  ${r.id}: ${r.trigger_conditions}`);

// Test tie-break now
const { invalidateCache, selectTemplateWithCandidates } = require('/opt/vp-marketing/dist/services/agentic/template-engine');
invalidateCache();

console.log('\n=== Re-test tie-break ===');
const tests = [
  { msg: 'chào bạn', expect: 'first_vague', ctx: { turn_number: 1, customer_is_new: true } },
  { msg: 'xin chào em muốn đặt phòng tuần sau 2 người', expect: 'first_contact_warm', ctx: { turn_number: 1, customer_is_new: true } },
  { msg: 'phòng gấp đêm nay', expect: 'first_with_urgency', ctx: { turn_number: 1, customer_is_new: true } },
];
for (const t of tests) {
  const r = selectTemplateWithCandidates({ ...t.ctx, message: t.msg });
  const ok = r.best?.id === t.expect ? '✅' : '❌';
  console.log(`  ${ok} "${t.msg}" → ${r.best?.id} (expect ${t.expect})`);
  console.log(`    candidates: ${r.candidates.map(c => c.id + ':' + c.score).join(', ')}`);
}

db.close();
console.log('\n✅ Re-seed + tie-break test complete');
JS

node /opt/vp-marketing/_tmp_reseed.js
rm /opt/vp-marketing/_tmp_reseed.js

pm2 restart vp-mkt --update-env 2>&1 | tail -2
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()
