"""Smoke test V2.2 Weekend Engine — script gen end-to-end (skip publish)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_weekend_smoke.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  console.log('=== STEP 1: Test theme rotation ===');
  const { getThemeForToday, getSundayOfMonth, pickSubjectForTheme, THEME_METADATA } =
    require('/opt/vp-marketing/dist/services/video-studio/weekend-engine');

  const todayTheme = getThemeForToday();
  const sundayInfo = getSundayOfMonth();
  console.log(`Today: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Is Sunday: ${sundayInfo.isSunday}`);
  console.log(`Sunday number: ${sundayInfo.sundayNum}`);
  console.log(`Today theme: ${todayTheme ? todayTheme.theme : 'not_sunday'}`);

  // Force test all 4 themes (regardless of today)
  console.log('\n--- Available themes ---');
  for (const [key, meta] of Object.entries(THEME_METADATA)) {
    console.log(`  ${key}: ${meta.label} (${meta.scenes_target} scenes, ${meta.duration_target_sec}s, voice=${meta.voice_style}, bgm=${meta.bgm_mood})`);
    console.log(`    subjects: ${meta.subjects.slice(0, 3).join(', ')}...`);
  }

  console.log('\n=== STEP 2: Test pick subject for each theme ===');
  for (const theme of ['day_in_area', 'inside_sonder', 'guest_story', 'why_sonder']) {
    const subject = pickSubjectForTheme(theme);
    console.log(`  ${theme} → "${subject}"`);
  }

  console.log('\n=== STEP 3: Test create project + generate script (using day_in_area) ===');
  const { createWeekendProject, generateScriptStep, getProject } =
    require('/opt/vp-marketing/dist/services/video-studio/weekend-orchestrator');

  // Force theme + subject for test
  const created = createWeekendProject({
    theme_type: 'day_in_area',
    theme_subject: 'Q1 (gần Bùi Viện)',
    generated_by: 'smoke_test',
  });
  if ('error' in created) { console.log('CREATE FAIL:', created.error); return; }
  console.log(`Project #${created.id} created: ${created.theme_type} / ${created.theme_subject}`);

  console.log('\n=== STEP 4: Generate script (Claude) ===');
  const r = await generateScriptStep(created.id);
  console.log(`Script result: ok=${r.ok} ${r.error || ''}`);

  if (r.ok) {
    const proj = getProject(created.id);
    const script = JSON.parse(proj.script_json);

    console.log('\n--- Generated Script ---');
    console.log(`Topic: ${proj.topic}`);
    console.log(`Hook: ${proj.hook_text}`);
    console.log(`Duration: ${proj.duration_sec}s, ${script.scenes.length} scenes`);
    console.log(`Caption: ${proj.caption_text?.substring(0, 100)}...`);
    console.log(`Hashtags: ${proj.hashtags_json}`);
    console.log(`Thumbnail prompt: ${script.thumbnail_prompt?.substring(0, 100)}...`);

    console.log('\n--- Scenes ---');
    for (const s of script.scenes) {
      console.log(`  ${s.scene_idx}. [${s.beat}] ${s.duration_sec}s ${s.overlay_text ? `(overlay: ${s.overlay_text})` : ''}`);
      console.log(`     Text: ${s.text.substring(0, 80)}...`);
      console.log(`     Visual prompt (${s.prefer_visual}): ${s.visual_prompt.substring(0, 80)}...`);
      console.log(`     Pexels query: ${s.visual_query}`);
      console.log(`     Mood: ${s.mood}, camera: ${s.camera}`);
    }

    console.log(`\nCost so far: $${(proj.cost_cents / 100).toFixed(2)}`);
  }

  // Cleanup
  db.prepare(`DELETE FROM weekend_videos WHERE generated_by = 'smoke_test'`).run();

  db.close();
  console.log('\n✅ Weekend smoke test complete');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_weekend_smoke.js
rm /opt/vp-marketing/_tmp_weekend_smoke.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=300)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:800])
c.close()
