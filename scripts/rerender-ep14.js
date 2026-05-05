/**
 * Re-render ep#14 với BGM mới (mood_warm Stable Audio).
 *
 * Flow:
 *   1. Load DB row → get script_json, voice_json, visuals_json
 *   2. Reconstruct voiceSegments + visuals từ stored paths (verify exist)
 *   3. Call anthology composer với BGM mới
 *   4. Save MP4 to data/media/anth-out/
 *   5. Update DB final_video_url
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = '/opt/vp-marketing/data/db.sqlite';
const EP_ID = 14;

(async () => {
  const db = new Database(DB_PATH);
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(EP_ID);
  if (!ep) { console.error('ep not found'); process.exit(1); }

  console.log(`Re-rendering ep#${ep.id} no=${ep.episode_no} "${ep.title}"`);

  const script = JSON.parse(ep.anthology_script_json);
  const voiceSegRaw = JSON.parse(ep.anthology_voice_json);
  const visualsRaw = JSON.parse(ep.anthology_visuals_json);

  // Verify all files exist
  let missing = 0;
  for (const v of voiceSegRaw) {
    if (!fs.existsSync(v.audio_path)) {
      console.warn(`  ⚠ missing voice: ${v.audio_path}`);
      missing++;
    }
  }
  for (const v of visualsRaw) {
    if (!fs.existsSync(v.local_path)) {
      console.warn(`  ⚠ missing visual: ${v.local_path}`);
      missing++;
    }
  }
  if (missing > 0) {
    console.error(`❌ ${missing} files missing, cannot re-render`);
    process.exit(1);
  }

  console.log(`  ✅ all ${voiceSegRaw.length} voice + ${visualsRaw.length} visual files exist`);

  // Reconstruct segments với text từ script.layers
  const voiceSegments = voiceSegRaw.map((v) => ({
    layer_no: v.layer_no,
    layer_name: v.layer_name,
    text: script.layers.find((l) => l.layer_no === v.layer_no)?.voiceover_text || '',
    audio_path: v.audio_path,
    duration_sec: v.duration_sec,
  }));

  const visuals = visualsRaw.map((v) => ({
    layer_no: v.layer_no,
    layer_name: v.layer_name,
    type: v.type,
    local_path: v.local_path,
    visual_prompt: script.layers.find((l) => l.layer_no === v.layer_no)?.visual_prompt || '',
  }));

  // Load anthology composer (compiled JS)
  const { composeAnthologyVideo, pickBgmForAnthology } = require('/opt/vp-marketing/dist/services/anthology/anthology-composer');

  const bgmPath = pickBgmForAnthology(script.bgm_mood || 'warm');
  console.log(`  BGM: ${bgmPath} (verified clean — Stable Audio 2.5)`);

  // New output path (overwrite old)
  const outputPath = `/opt/vp-marketing/data/media/anth-out/anth-2026-05-04-ep${ep.episode_no}-linh-rerender.mp4`;

  console.log(`  composing → ${outputPath}`);
  const result = await composeAnthologyVideo({
    script,
    visuals,
    voiceSegments,
    bgmPath,
    outputPath,
    episodeNo: ep.episode_no,
  });

  console.log(`  ✅ rendered ${result.duration_sec.toFixed(1)}s, ${(result.size_bytes / 1024 / 1024).toFixed(2)}MB`);

  // Update DB
  const filename = path.basename(result.output_path);
  const finalUrl = `https://app.sondervn.com/media/anth-out/${filename}`;
  db.prepare(`
    UPDATE story_episodes
    SET final_video_url = ?,
        video_duration_sec = ?,
        bgm_path = ?,
        error = 're-rendered with clean BGM 2026-05-05',
        updated_at = ?
    WHERE id = ?
  `).run(finalUrl, Math.round(result.duration_sec), bgmPath, Date.now(), EP_ID);

  // Verify
  const updated = db.prepare(`SELECT final_video_url, bgm_path, status FROM story_episodes WHERE id = ?`).get(EP_ID);
  console.log(`\n✅ DB updated:`);
  console.log(`   final_video_url: ${updated.final_video_url}`);
  console.log(`   bgm_path: ${updated.bgm_path}`);
  console.log(`   status: ${updated.status}`);

  db.close();
  console.log(`\nNext: republish ep#${ep.id} via /api/anthology/episodes/${ep.id}/publish-now or admin UI`);
})();
