"""Smoke test V2.1 Tips Engine — gen 1 pilot video end-to-end (skip publish)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_tips_smoke.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  console.log('=== STEP 1: Generate 5 ideas booking_tips ===');
  const { generateIdeas, saveIdeas, pickNextIdea } = require('/opt/vp-marketing/dist/services/video-studio/tips-engine');
  const ideas = await generateIdeas('booking_tips', 5);
  console.log(`Generated ${ideas.length} ideas:`);
  for (const i of ideas) {
    console.log(`  - ${i.topic} (${i.hook_pattern}, score=${i.relevance_score.toFixed(2)})`);
  }
  const saved = saveIdeas(ideas);
  console.log(`Saved: ${saved.saved}, skipped: ${saved.skipped}`);

  console.log('\n=== STEP 2: Pick + create project ===');
  const idea = pickNextIdea('booking_tips');
  if (!idea) { console.log('NO IDEA'); return; }
  console.log(`Picked: ${idea.topic}`);

  const { createTipsProject, generateScriptStep } = require('/opt/vp-marketing/dist/services/video-studio/tips-orchestrator');
  const created = createTipsProject({
    category: 'booking_tips',
    topic: idea.topic,
    hook_pattern: idea.hook_pattern,
    generated_by: 'smoke_test',
  });
  if ('error' in created) { console.log('CREATE FAIL:', created.error); return; }
  console.log(`Project #${created.id} created`);

  console.log('\n=== STEP 3: Generate script (Claude) ===');
  const scriptR = await generateScriptStep(created.id);
  console.log(`Script result: ok=${scriptR.ok} ${scriptR.error || ''}`);

  if (scriptR.ok) {
    const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(created.id);
    const tips = JSON.parse(proj.tips_json);
    const variants = JSON.parse(proj.hook_variants_json || '{}');

    console.log('\n--- Generated Script ---');
    console.log(`Hook A: ${variants.A?.substring(0, 100)}`);
    console.log(`Hook B: ${variants.B?.substring(0, 100)}`);
    console.log(`Tips:`);
    for (const t of tips) {
      console.log(`  ${t.number}. [${t.title}] ${t.text.substring(0, 80)}...`);
      console.log(`     query: ${t.visual_query}`);
    }
    console.log(`CTA: ${proj.cta_text}`);
    console.log(`Caption: ${proj.caption_text?.substring(0, 100)}`);
    console.log(`Hashtags: ${proj.hashtags_json}`);
    console.log(`Cost so far: $${(proj.cost_cents / 100).toFixed(2)}`);
  }

  // Cleanup
  db.prepare(`DELETE FROM tips_hook_experiments WHERE video_id IN (SELECT id FROM tips_videos WHERE generated_by = 'smoke_test')`).run();
  db.prepare(`DELETE FROM tips_videos WHERE generated_by = 'smoke_test'`).run();
  db.prepare(`DELETE FROM tips_ideas WHERE topic LIKE '%' AND used_video_id IS NULL`).run();  // Keep ideas in DB but mark for testing

  db.close();
  console.log('\n✅ Smoke test complete');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_tips_smoke.js
rm /opt/vp-marketing/_tmp_tips_smoke.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=300)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:800])
c.close()
