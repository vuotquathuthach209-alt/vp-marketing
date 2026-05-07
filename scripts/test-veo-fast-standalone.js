/**
 * Standalone test: 1 Veo Fast shot ($0.15/s × 6s = $0.90) to diagnose FAL queue.
 *
 * Goals:
 *   1. Verify FAL submit endpoint responds quickly (<60s)
 *   2. Verify polling URL pattern works (owner-only path from status_url)
 *   3. Measure actual queue → completion time
 *   4. Verify fetch result URL pattern (full model path)
 *   5. Verify download succeeds
 */

const Database = require('better-sqlite3');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const KEY = db.prepare(`SELECT value FROM settings WHERE key = 'fal_api_key'`).get().value;
db.close();

const auth = { Authorization: `Key ${KEY}` };
const MODEL = 'fal-ai/veo3/fast';
const QUEUE_BASE = 'https://queue.fal.run';

(async () => {
  const totalStart = Date.now();

  // ═══ STEP 1: Submit ═══
  console.log('═'.repeat(70));
  console.log('Test 1 Veo Fast shot — diagnose FAL queue');
  console.log('═'.repeat(70));
  const submitStart = Date.now();
  console.log(`\n[STEP 1] Submitting Veo Fast job...`);
  let submitR;
  try {
    submitR = await axios.post(
      `${QUEUE_BASE}/${MODEL}`,
      {
        prompt: 'macro raindrop on glass at night, warm amber light blur, cinematic, no people',
        aspect_ratio: '9:16',
        duration: '6s',
        generate_audio: false,           // cheaper without audio
        enhance_prompt: true,
      },
      { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 60_000 },
    );
  } catch (e) {
    console.error(`SUBMIT FAIL: ${e.response?.status} ${e.response?.data?.detail || e.message}`);
    process.exit(1);
  }
  const submitMs = Date.now() - submitStart;
  console.log(`  ✅ Submit OK in ${submitMs}ms`);
  console.log(`     request_id: ${submitR.data.request_id}`);
  console.log(`     status_url: ${submitR.data.status_url}`);
  console.log(`     response_url: ${submitR.data.response_url}`);

  // ═══ STEP 2: Poll status ═══
  console.log(`\n[STEP 2] Polling status (5s interval)...`);
  const pollStart = Date.now();
  let lastStatus = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await axios.get(submitR.data.status_url, { headers: auth, timeout: 30_000 });
      lastStatus = r.data;
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
      console.log(`  [poll #${i + 1} @ ${elapsed}s] status=${lastStatus.status} queue_pos=${lastStatus.queue_position || 0}`);
      if (lastStatus.status === 'COMPLETED') break;
      if (lastStatus.status === 'FAILED') {
        console.error(`  ❌ FAILED:`, JSON.stringify(lastStatus.logs).slice(0, 500));
        process.exit(1);
      }
    } catch (e) {
      console.warn(`  poll err: ${e.response?.status} ${e.response?.data?.detail || e.message}`);
    }
  }

  const pollMs = Date.now() - pollStart;
  if (lastStatus?.status !== 'COMPLETED') {
    console.error(`\n❌ Did not complete after ${pollMs}ms — FAL queue is severely backed up`);
    process.exit(2);
  }
  console.log(`  ✅ Completed in ${(pollMs / 1000).toFixed(1)}s`);

  // ═══ STEP 3: Fetch result via FULL PATH URL ═══
  console.log(`\n[STEP 3] Fetching result (full-path URL)...`);
  const fetchStart = Date.now();
  const fullResultUrl = `${QUEUE_BASE}/${MODEL}/requests/${submitR.data.request_id}`;
  console.log(`  URL: ${fullResultUrl}`);
  let result;
  try {
    const r = await axios.get(fullResultUrl, { headers: auth, timeout: 30_000 });
    result = r.data;
  } catch (e) {
    console.error(`  ❌ FETCH FAIL: ${e.response?.status} ${e.response?.data?.detail || e.message}`);
    process.exit(1);
  }
  const fetchMs = Date.now() - fetchStart;
  console.log(`  ✅ Fetch OK in ${fetchMs}ms`);
  console.log(`     keys: ${Object.keys(result).join(', ')}`);
  const videoUrl = result.video?.url || result.url;
  console.log(`     video URL: ${videoUrl?.slice(0, 100)}...`);

  // ═══ STEP 4: Download ═══
  console.log(`\n[STEP 4] Downloading video...`);
  const dlStart = Date.now();
  const localPath = `/tmp/veo-test-${Date.now()}.mp4`;
  try {
    const dl = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 100 * 1024 * 1024,
    });
    fs.writeFileSync(localPath, Buffer.from(dl.data));
  } catch (e) {
    console.error(`  ❌ DOWNLOAD FAIL: ${e.message}`);
    process.exit(1);
  }
  const dlMs = Date.now() - dlStart;
  const sizeMB = (fs.statSync(localPath).size / 1024 / 1024).toFixed(2);
  console.log(`  ✅ Downloaded ${sizeMB}MB in ${dlMs}ms → ${localPath}`);

  // ═══ SUMMARY ═══
  const totalMs = Date.now() - totalStart;
  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  console.log(`Submit:     ${submitMs}ms`);
  console.log(`FAL queue:  ${(pollMs / 1000).toFixed(1)}s (queue + processing)`);
  console.log(`Fetch:      ${fetchMs}ms`);
  console.log(`Download:   ${(dlMs / 1000).toFixed(1)}s`);
  console.log(`TOTAL:      ${(totalMs / 1000).toFixed(1)}s = ${(totalMs / 1000 / 60).toFixed(1)} min`);
  console.log(`Cost:       ~$0.60 (Veo Fast 6s no audio)`);
  console.log(`Output:     ${localPath} (${sizeMB}MB)`);
})();
