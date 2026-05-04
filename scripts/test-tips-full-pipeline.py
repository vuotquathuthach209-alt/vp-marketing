"""Test FULL pipeline V2.1 Tips: script → visuals → voice → compose → MP4 file."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_full_pipeline.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('data/db.sqlite');

(async () => {
  const orch = require('/opt/vp-marketing/dist/services/video-studio/tips-orchestrator');
  const tipsEngine = require('/opt/vp-marketing/dist/services/video-studio/tips-engine');

  // Pre-load 1 idea if needed
  let idea = tipsEngine.pickNextIdea('booking_tips');
  if (!idea) {
    console.log('No unused idea — generate 3 first');
    const ideas = await tipsEngine.generateIdeas('booking_tips', 3);
    tipsEngine.saveIdeas(ideas);
    idea = tipsEngine.pickNextIdea('booking_tips');
  }
  console.log(`Using idea: ${idea.topic}`);

  // STEP 1: Create project
  console.log('\n=== STEP 1: Create project ===');
  const created = orch.createTipsProject({
    category: 'booking_tips',
    topic: idea.topic,
    hook_pattern: idea.hook_pattern,
    generated_by: 'pilot_test',
  });
  if ('error' in created) { console.log('FAIL:', created.error); return; }
  const pid = created.id;
  console.log(`Project #${pid} created`);

  // STEP 2: Script
  console.log('\n=== STEP 2: Generate script ===');
  const t1 = Date.now();
  const r1 = await orch.generateScriptStep(pid);
  console.log(`Script: ok=${r1.ok} time=${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (!r1.ok) { console.log('SCRIPT FAIL:', r1.error); return; }

  // STEP 3: Visuals
  console.log('\n=== STEP 3: Fetch visuals (Pexels) ===');
  const t2 = Date.now();
  const r2 = await orch.fetchVisualsStep(pid);
  console.log(`Visuals: fetched=${r2.fetched}/5, time=${((Date.now() - t2) / 1000).toFixed(1)}s`);
  if (!r2.ok) { console.log('VISUALS FAIL:', r2.error); return; }

  // STEP 4: Voice (ElevenLabs)
  console.log('\n=== STEP 4: Synthesize voice (ElevenLabs) ===');
  const t3 = Date.now();
  const r3 = await orch.synthesizeVoiceStep(pid);
  console.log(`Voice: ok=${r3.ok} time=${((Date.now() - t3) / 1000).toFixed(1)}s ${r3.error || ''}`);
  if (!r3.ok) { console.log('VOICE FAIL:', r3.error); return; }

  // STEP 5: Compose (FFmpeg)
  console.log('\n=== STEP 5: Compose video (FFmpeg) ===');
  const t4 = Date.now();
  const r4 = await orch.composeStep(pid);
  console.log(`Compose: ok=${r4.ok} time=${((Date.now() - t4) / 1000).toFixed(1)}s url=${r4.video_url} duration=${r4.duration?.toFixed(1)}s ${r4.error || ''}`);

  if (r4.ok) {
    const localPath = '/opt/vp-marketing/data/media/' + (r4.video_url || '').replace('/media/', '');
    if (fs.existsSync(localPath)) {
      const size = fs.statSync(localPath).size;
      console.log(`✓ MP4 file: ${(size / 1024 / 1024).toFixed(1)}MB at ${localPath}`);
    }
  }

  // Final stats
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(pid);
  console.log(`\n=== Final stats ===`);
  console.log(`Status: ${proj.status}`);
  console.log(`Duration: ${proj.duration_sec}s`);
  console.log(`Cost so far: $${(proj.cost_cents / 100).toFixed(2)}`);
  console.log(`Total time: ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  db.close();
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_full_pipeline.js
rm /opt/vp-marketing/_tmp_full_pipeline.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=600)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:1500])
c.close()
