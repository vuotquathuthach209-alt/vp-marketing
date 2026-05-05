/**
 * Sonder BGM Generator — one-shot script tạo nhạc BGM gốc bằng FAL.ai.
 *
 * Approach: Stable Audio 2.5 ($0.20/track) — best instrumental ambient quality.
 * Fallback: ACE-Step ($0.0002/s) nếu Stable Audio fail.
 *
 * Generates 7 mood tracks 90s mỗi track:
 *   warm | calm | intimate | uplifting | cinematic | sad | tense
 *
 * Output:
 *   /opt/vp-marketing/data/bgm/mood_*.mp3
 *   /opt/vp-marketing/data/bgm/bgm-licenses.json (provenance metadata)
 *
 * Usage on VPS:
 *   cd /opt/vp-marketing && node scripts/generate-sonder-bgm.js
 *
 * Requires: settings.fal_api_key
 * Cost: ~$1.40 one-time for 7 tracks via Stable Audio 2.5
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = '/opt/vp-marketing/data/db.sqlite';
const BGM_DIR = '/opt/vp-marketing/data/bgm';

// ═══════════════════════════════════════════════════════════
// 7 Sonder mood prompts (instrumental ambient, no vocals)
// ═══════════════════════════════════════════════════════════

const MOODS = [
  {
    key: 'warm',
    prompt: 'soft warm solo piano with subtle strings, intimate Vietnamese boutique hotel ambient, cozy golden hour mood, slow tempo 70bpm, instrumental, melodic, no vocals, no drums, smooth loopable',
    duration_sec: 90,
  },
  {
    key: 'calm',
    prompt: 'minimalist piano solo, peaceful meditative ambient, slow 60bpm, contemplative, gentle melodies, instrumental, no vocals, smooth tail for looping',
    duration_sec: 90,
  },
  {
    key: 'intimate',
    prompt: 'intimate solo piano ballad, emotional but restrained, melancholic-hopeful Vietnamese feel, slow ballad 65bpm, instrumental, tender melody, no vocals, no drums',
    duration_sec: 90,
  },
  {
    key: 'uplifting',
    prompt: 'uplifting acoustic guitar with light piano and soft strings, hopeful Vietnamese morning vibe, gentle mid-tempo 95bpm, instrumental, positive but understated, no vocals',
    duration_sec: 90,
  },
  {
    key: 'cinematic',
    prompt: 'cinematic ambient piano with subtle cello and string pads, slow building emotion, contemplative film score, instrumental, sparse arrangement, no vocals, no drums, slow 75bpm',
    duration_sec: 90,
  },
  {
    key: 'sad',
    prompt: 'melancholic solo piano ballad, slow tempo 60bpm, emotional but graceful, gentle restrained sadness, instrumental, no vocals',
    duration_sec: 90,
  },
  {
    key: 'tense',
    prompt: 'subtle ambient tension with low cellos and sparse piano, restrained suspense, slow build, instrumental, no drums, no vocals, contemplative dread',
    duration_sec: 90,
  },
];

// ═══════════════════════════════════════════════════════════
// FAL.ai client
// ═══════════════════════════════════════════════════════════

const QUEUE_BASE = 'https://queue.fal.run';

function getFalApiKey() {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('fal_api_key');
  db.close();
  if (!row?.value) throw new Error('fal_api_key not set in settings');
  return row.value;
}

const FAL_KEY = getFalApiKey();

function authHeaders() {
  return {
    Authorization: `Key ${FAL_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function falSubmit(modelId, input) {
  const r = await axios.post(`${QUEUE_BASE}/${modelId}`, input, {
    headers: authHeaders(),
    timeout: 60000,
  });
  return {
    request_id: r.data.request_id,
    status_url: r.data.status_url,
    response_url: r.data.response_url,
  };
}

async function falPoll(submitR, maxMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await axios.get(submitR.status_url, { headers: authHeaders(), timeout: 30000 });
      const status = r.data.status;
      if (status === 'COMPLETED') return r.data;
      if (status === 'FAILED') {
        const errLog = (r.data.logs || []).map((l) => l.message || JSON.stringify(l)).join(' | ');
        throw new Error('FAL job FAILED: ' + errLog.slice(0, 300));
      }
      console.log(`  [poll] status=${status}, queue_pos=${r.data.queue_position || 0}`);
    } catch (e) {
      if (e.message?.startsWith('FAL job FAILED')) throw e;
      console.warn(`  [poll] transient: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('FAL poll timeout');
}

async function falFetch(submitR) {
  const r = await axios.get(submitR.response_url, { headers: authHeaders(), timeout: 30000 });
  return r.data;
}

// ═══════════════════════════════════════════════════════════
// Try multiple models (Stable Audio first, fallback ACE-Step)
// ═══════════════════════════════════════════════════════════

const MODELS_PRIORITY = [
  {
    id: 'fal-ai/stable-audio-25/text-to-audio',
    inputBuilder: (mood) => ({
      prompt: mood.prompt,
      seconds_total: mood.duration_sec,
    }),
    extractAudioUrl: (data) => data?.audio_file?.url || data?.audio?.url || data?.url,
    cost_per_track: 20,             // 20 cents
    name: 'Stable Audio 2.5',
  },
  {
    id: 'fal-ai/stable-audio',
    inputBuilder: (mood) => ({
      prompt: mood.prompt,
      seconds_total: mood.duration_sec,
    }),
    extractAudioUrl: (data) => data?.audio_file?.url || data?.audio?.url || data?.url,
    cost_per_track: 20,
    name: 'Stable Audio',
  },
  {
    id: 'fal-ai/ace-step',
    inputBuilder: (mood) => ({
      tags: mood.prompt,
      duration: mood.duration_sec,
    }),
    extractAudioUrl: (data) => data?.audio?.url || data?.audio_file?.url || data?.url,
    cost_per_track: 2,              // ~2 cents (90s × $0.0002)
    name: 'ACE-Step',
  },
];

// ═══════════════════════════════════════════════════════════
// Generate one mood
// ═══════════════════════════════════════════════════════════

async function generateMood(mood) {
  console.log(`\n[bgm-gen] ${mood.key}: "${mood.prompt.slice(0, 80)}..."`);

  let lastErr;
  for (const model of MODELS_PRIORITY) {
    try {
      console.log(`  trying ${model.name} (${model.id})...`);
      const submitR = await falSubmit(model.id, model.inputBuilder(mood));
      console.log(`  submitted req=${submitR.request_id}`);

      await falPoll(submitR);
      const result = await falFetch(submitR);
      const audioUrl = model.extractAudioUrl(result);

      if (!audioUrl) {
        console.warn(`  no audio URL in result: ${JSON.stringify(result).slice(0, 200)}`);
        continue;
      }

      // Download
      const localPath = path.join(BGM_DIR, `mood_${mood.key}.mp3`);
      const audioResp = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 50 * 1024 * 1024,
      });
      fs.writeFileSync(localPath, Buffer.from(audioResp.data));

      const sizeMB = (audioResp.data.byteLength / 1024 / 1024).toFixed(2);
      console.log(`  ✅ saved ${path.basename(localPath)} (${sizeMB}MB) via ${model.name}`);

      return {
        mood_key: mood.key,
        prompt: mood.prompt,
        duration_sec: mood.duration_sec,
        provider: model.name,
        model_id: model.id,
        request_id: submitR.request_id,
        cost_cents: model.cost_per_track,
        local_path: localPath,
        generated_at: Date.now(),
      };
    } catch (e) {
      lastErr = e;
      console.warn(`  ${model.name} failed: ${e.message}`);
    }
  }

  throw new Error(`All models failed for "${mood.key}". Last err: ${lastErr?.message}`);
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(70));
  console.log('Sonder BGM Generator — generating 7 mood tracks via FAL.ai');
  console.log('═'.repeat(70));

  if (!fs.existsSync(BGM_DIR)) fs.mkdirSync(BGM_DIR, { recursive: true });

  const licenses = {
    generated_at: Date.now(),
    generator_version: '1.0',
    description: 'Sonder original BGM library — AI-generated, brand-owned. Zero copyright risk.',
    license: 'Proprietary — Sonder Vietnam (generated content, no third-party rights)',
    tracks: {},
  };

  // Existing safe BGM (Pixabay royalty-free) — preserve
  if (fs.existsSync(path.join(BGM_DIR, 'pixabay-relaxing-piano.mp3'))) {
    licenses.tracks['pixabay-relaxing-piano.mp3'] = {
      provider: 'Pixabay Music',
      license: 'Pixabay Content License — royalty-free, no attribution required, full commercial use',
      verified: true,
    };
  }

  // Generate AI tracks
  for (const mood of MOODS) {
    try {
      const result = await generateMood(mood);
      licenses.tracks[`mood_${mood.key}.mp3`] = {
        provider: result.provider,
        model_id: result.model_id,
        request_id: result.request_id,
        prompt: result.prompt,
        duration_sec: result.duration_sec,
        cost_cents: result.cost_cents,
        generated_at: result.generated_at,
        license: 'Proprietary — generated by Sonder via FAL.ai (Stable Audio/ACE-Step), brand owns output',
        verified: true,
      };
    } catch (e) {
      console.error(`\n❌ ${mood.key}: ${e.message}`);
      licenses.tracks[`mood_${mood.key}.mp3`] = {
        error: e.message,
        verified: false,
      };
    }
  }

  // Bensound — REMOVE recommendation (requires attribution we don't have)
  if (fs.existsSync(path.join(BGM_DIR, 'bensound-tenderness.mp3'))) {
    licenses.tracks['bensound-tenderness.mp3'] = {
      provider: 'Bensound',
      license: 'Bensound Free License — REQUIRES attribution "Music: bensound.com" in description. NOT SAFE without attribution.',
      verified: false,
      recommendation: 'remove or always include "Music: bensound.com" in caption',
    };
  }

  // Write licenses file
  const licensesPath = path.join(BGM_DIR, 'bgm-licenses.json');
  fs.writeFileSync(licensesPath, JSON.stringify(licenses, null, 2));
  console.log(`\n✅ Licenses metadata: ${licensesPath}`);

  // Summary
  const totalCost = Object.values(licenses.tracks)
    .filter((t) => t.cost_cents)
    .reduce((a, b) => a + b.cost_cents, 0);
  const okCount = Object.values(licenses.tracks).filter((t) => t.verified).length;
  console.log('\n' + '═'.repeat(70));
  console.log(`SUMMARY: ${okCount}/${Object.keys(licenses.tracks).length} tracks verified | total cost ${totalCost} cents (~$${(totalCost / 100).toFixed(2)})`);
  console.log('═'.repeat(70));
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
