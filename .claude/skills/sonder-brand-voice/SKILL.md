---
name: sonder-brand-voice
description: Sonder brand voice chuẩn cho TTS/voice output trên mọi module video, audio, voice notification. Use khi build/refactor/debug bất kỳ feature TTS cho video Reels/Shorts, audio voiceover, podcast, voice message bot, hoặc khi user mention "giọng Sonder", "voice clone Ngân", "Edge-TTS HoaiMy", "speech-to-speech STS". Đảm bảo consistency thương hiệu trên toàn hệ sinh thái.
---

# Sonder Brand Voice — Standard

> **MỤC ĐÍCH**: Đảm bảo MỌI voice output trên hệ Sonder dùng cùng pattern + voice ID = audience nhận ra ngay tức khắc đó là Sonder ("brand audio recognition"). Áp dụng cho video Reels/Shorts (Story/Tips/Weekend), voice notification, podcast, future TTS features.

---

## 🎙 Giọng chuẩn thương hiệu

```
═══════════════════════════════════════════════════════════════
  GIỌNG SONDER — "Ngân"
  ElevenLabs Voice ID: a3AkyqGG4v8Pg7SWQ0Y3
═══════════════════════════════════════════════════════════════
  Tone:        warm, intimate, observational, slightly poetic
  Audience:    du khách trẻ 22-40 VN, có gu, không sến
  Languages:   Tiếng Việt (primary), accent miền Nam nhẹ
  Pitch:       trung tính-thấp (29 Hz baseline)
  Speed:       hơi chậm hơn natural (rate -3% via Edge-TTS)
  Style:       lát cắt cảm xúc, ý tự thành, không hard-sell
═══════════════════════════════════════════════════════════════
```

**Reference video** (giọng chuẩn):
- Story Engine ep 1 "Sài Gòn Tháng Năm" tập 1
- YouTube Shorts: https://www.youtube.com/shorts/ZsnEp0ltOWg
- Bất kỳ video nào sau ngày 24/4/2026 với Story Engine

---

## ⚙️ Pattern bắt buộc — 2-step pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│  STEP 1: Edge-TTS Vietnamese (Microsoft Neural)                  │
│  Voice: vi-VN-HoaiMyNeural                                       │
│  Rate: -3% (slightly slower for warmth)                          │
│  Pitch: +3Hz                                                      │
│  Output: reference audio mp3 (chuẩn 100% phát âm VN)             │
│  Cost: FREE (open source python lib)                             │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼ feed reference vào STS
┌──────────────────────────────────────────────────────────────────┐
│  STEP 2: ElevenLabs Speech-to-Speech                             │
│  Endpoint: POST /v1/speech-to-speech/{voice_id}                  │
│  Model: eleven_multilingual_sts_v2                               │
│  Voice: a3AkyqGG4v8Pg7SWQ0Y3 (Ngân clone)                        │
│  Voice settings:                                                 │
│    stability: 0.5                                                │
│    similarity_boost: 0.85                                        │
│    style: 0.3                                                    │
│    use_speaker_boost: true                                       │
│  Output: mp3 final (giọng Ngân + pronunciation Edge)             │
│  Cost: ~$0.30/1000 chars                                         │
└──────────────────────────────────────────────────────────────────┘
```

### Tại sao 2-step (không direct ElevenLabs TTS)?

**Direct ElevenLabs `multilingual_v2` đọc tiếng Việt KHÔNG hoàn hảo:**
- Phát âm méo các phụ âm cuối (-ch, -nh, -ng)
- Sai dấu thanh khi gặp từ phức (vd: "đắt" → "dắt")
- Tone không khớp accent miền Nam

**Edge-TTS HoaiMyNeural là VN native model:**
- Microsoft training trên dataset Việt Nam thực sự
- Pronunciation chính xác 99%+
- Free, không quota limit

**STS giữ pronunciation Edge + apply timbre Ngân:**
- Best of both worlds: chuẩn VN + giọng natural Sonder
- Output không bị robotic như Edge-only

---

## 📦 Setting keys (DB `settings` table)

| Key | Value | Purpose |
|-----|-------|---------|
| `vs_elevenlabs_voice_id_owner` | `a3AkyqGG4v8Pg7SWQ0Y3` | **Master Sonder voice — DO NOT CHANGE** |
| `vs_elevenlabs_voice_id` | `a3AkyqGG4v8Pg7SWQ0Y3` | Default fallback |
| `vs_edge_tts_voice` | `vi-VN-HoaiMyNeural` | Edge-TTS voice |
| `vs_edge_tts_rate` | `-3%` | Slightly slower |
| `vs_edge_tts_pitch` | `+3Hz` | Slight pitch adjustment |
| `elevenlabs_api_key` | `sk_...` | API key |

### Voice ID priority chain (per module)

Trong mỗi composer/voice module, dùng priority chain này để pick voice:

```typescript
const voiceId =
  getSetting(`vs_elevenlabs_voice_id_${moduleVoiceStyle}`)  // Per-module override (rare)
  || getSetting('vs_elevenlabs_voice_id_owner')             // Master Sonder voice
  || getSetting('vs_elevenlabs_voice_id')                   // Generic default
  || undefined;
```

**Khi nào override per-module?**
- Tạo content cần persona khác hẳn (vd: voice "tin tức nghiêm túc" cho podcast)
- Multi-character podcast (mỗi character 1 voice)
- A/B test voice mới

**Mặc định**: dùng Ngân (a3AkyqGG4v8Pg7SWQ0Y3) cho tất cả → audio brand consistency.

---

## 🛠 Implementation reference

### Code template (TypeScript)

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
const FormData = require('form-data');
import { getSetting } from '../../db';

/**
 * STEP 1: Edge-TTS Vietnamese → reference audio.
 * Free, chuẩn pronunciation 99%.
 */
async function edgeTtsVietnamese(text: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  const voice = getSetting('vs_edge_tts_voice') || 'vi-VN-HoaiMyNeural';
  const rate = getSetting('vs_edge_tts_rate') || '-3%';
  const pitch = getSetting('vs_edge_tts_pitch') || '+3Hz';

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = spawnSync('python3', [
        '-m', 'edge_tts',
        `--voice=${voice}`,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        `--text`, text,
        `--write-media`, outPath,
      ], { encoding: 'utf8', timeout: 120_000 });

      if (r.status !== 0) throw new Error('edge-tts: ' + (r.stderr || '').slice(-200));
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) throw new Error('empty edge audio');
      return { ok: true };
    } catch (e: any) {
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 2000));
      else return { ok: false, error: e?.message };
    }
  }
  return { ok: false, error: 'max retries' };
}

/**
 * STEP 2: ElevenLabs Speech-to-Speech với Ngân voice.
 */
async function elevenLabsStsVietnamese(refAudioPath: string, voiceId: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = getSetting('elevenlabs_api_key') || getSetting('vs_elevenlabs_api_key');
  if (!apiKey) return { ok: false, error: 'no_elevenlabs_key' };

  try {
    const form = new FormData();
    form.append('audio', fs.createReadStream(refAudioPath), { filename: 'source.mp3', contentType: 'audio/mpeg' });
    form.append('model_id', 'eleven_multilingual_sts_v2');
    form.append('voice_settings', JSON.stringify({
      stability: 0.5,
      similarity_boost: 0.85,
      style: 0.3,
      use_speaker_boost: true,
    }));

    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}`,
      form,
      {
        headers: { 'xi-api-key': apiKey, ...form.getHeaders(), 'Accept': 'audio/mpeg' },
        responseType: 'arraybuffer',
        timeout: 180_000,
        maxContentLength: 50 * 1024 * 1024,
      }
    );
    fs.writeFileSync(outPath, Buffer.from(resp.data));
    return { ok: true };
  } catch (e: any) {
    const errBody = e.response?.data ? Buffer.from(e.response.data).toString('utf8').substring(0, 300) : e.message;
    return { ok: false, error: errBody };
  }
}

/**
 * Combined: Edge-TTS → STS với fallback Edge-only.
 * Use this function in mọi composer/voice module mới.
 */
export async function synthesizeSonderVoice(
  text: string,
  outPath: string,
  voiceIdOverride?: string,
): Promise<{ ok: boolean; error?: string; mode: 'sts' | 'edge_only' | 'none' }> {
  const voiceId = voiceIdOverride
    || getSetting('vs_elevenlabs_voice_id_owner')
    || getSetting('vs_elevenlabs_voice_id')
    || undefined;

  const ts = Date.now() + Math.floor(Math.random() * 1000);
  const edgeRefPath = outPath.replace(/\.mp3$/, `-edge-ref-${ts}.mp3`);

  // Step 1: Edge-TTS reference
  const edgeR = await edgeTtsVietnamese(text, edgeRefPath);
  if (!edgeR.ok) return { ok: false, error: 'edge-tts: ' + edgeR.error, mode: 'none' };

  // Step 2: STS với Ngân (nếu có voice ID + API key)
  if (voiceId) {
    const stsR = await elevenLabsStsVietnamese(edgeRefPath, voiceId, outPath);
    if (stsR.ok) {
      try { fs.unlinkSync(edgeRefPath); } catch {}
      return { ok: true, mode: 'sts' };
    }
    console.warn(`[sonder-voice] STS fail, fallback Edge: ${stsR.error?.substring(0, 100)}`);
  }

  // Fallback: Edge-only (vẫn chuẩn VN nhưng giọng robotic)
  fs.copyFileSync(edgeRefPath, outPath);
  try { fs.unlinkSync(edgeRefPath); } catch {}
  return { ok: true, mode: 'edge_only' };
}
```

---

## 🚨 Anti-patterns — KHÔNG được làm

### ❌ Direct ElevenLabs TTS
```typescript
// SAI — dùng multilingual_v2 đọc tiếng Việt sẽ accent kỳ
await axios.post(
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
  { text, model_id: 'eleven_multilingual_v2' }
);
```

### ❌ Hardcode voice ID khác Ngân
```typescript
// SAI — mỗi module hardcode voice riêng → brand inconsistency
const voiceId = 'XB0fDUnXU5powFXDhCwa'; // Charlotte
const voiceId = 'pFZP5JQG7iQjIQuC4Bku'; // Lily
```

### ❌ Skip Edge-TTS step để "tiết kiệm thời gian"
```typescript
// SAI — direct STS với text là không hợp lệ (STS cần audio input)
// Edge-TTS step KHÔNG thể skip
```

### ❌ Dùng different STS settings
```typescript
// SAI — phải đồng nhất settings:
voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.3 }
```

---

## ✅ Checklist khi build feature mới có voice/TTS

Trước khi merge code:

- [ ] Import `synthesizeSonderVoice` từ shared module (KHÔNG copy-paste 2 functions edge + sts)
- [ ] Dùng voice ID từ `vs_elevenlabs_voice_id_owner` (KHÔNG hardcode)
- [ ] Edge-TTS settings đồng nhất: `vi-VN-HoaiMyNeural`, rate `-3%`, pitch `+3Hz`
- [ ] STS model: `eleven_multilingual_sts_v2`
- [ ] STS voice settings: `stability: 0.5, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true`
- [ ] Có fallback Edge-only nếu STS fail
- [ ] Log mode (`sts` vs `edge_only`) per segment
- [ ] Cleanup edge ref file sau khi STS thành công
- [ ] Test 1 sample → verify giọng giống tập 1 Story Engine reference

---

## 🎬 Audio brand kit khác (extending voice)

### Background music moods
```
/opt/vp-marketing/data/bgm/
├── mood_calm.mp3         # Lát cắt cảm xúc nhẹ
├── mood_warm.mp3         # Storytelling Linh
├── mood_uplifting.mp3    # Tips, daily content
├── mood_cinematic.mp3    # Weekend Special
├── mood_intimate.mp3     # Close-up emotional
├── mood_sad.mp3          # Bittersweet moments
├── mood_tense.mp3        # Build-up scenes
└── sonder-soft.mp3       # Default fallback
```

BGM ducking sidechain settings (đồng nhất):
```
threshold=0.05, ratio=8, attack=5, release=200-250, level_sc=1
voice_volume=1.0, bgm_volume=0.20-0.30 (tùy module)
```

### Voice EQ (post-STS for clarity)
```
equalizer=f=120:t=q:w=2:g=-3   (cut mud)
equalizer=f=2400:t=q:w=2:g=2   (presence)
equalizer=f=4500:t=q:w=2:g=1   (air)
acompressor=threshold=0.1:ratio=3:attack=20:release=200
```

### Watermark logo
```
Path: /opt/vp-marketing/data/brand/sonder-logo.png
Size: 80x80
Position: bottom-right, padding 30px right, 60px bottom
Alpha: 0.35 (constant — KHÔNG fade)
Format: PNG with white background → colorkey strip
```

---

## 📊 Tracking + monitoring

### Cost tracking
- Edge-TTS: free
- ElevenLabs STS: ~$0.30/1000 chars input text
- Average: ~$0.20/video 75-120s
- Monthly @ 24 videos: ~$5

### Quality metrics
- Mode percentage: target 95%+ STS, <5% edge_only fallback
- Whisper verify gate (post-compose): lang=vi + ≥60% scenes pass keyword check (proven pattern in story-to-video.ts)

---

## 🔗 Files reference (existing implementations)

Chuẩn nhất:
- `src/services/story-to-video.ts` — Story Engine (ORIGINAL pattern)
- `src/services/video-studio/tips-composer.ts` — Tips (V2.1)
- `src/services/video-studio/weekend-composer.ts` — Weekend (V2.2)

---

## 🎯 Tương lai mở rộng (KHI thêm voice mới)

### Trường hợp được phép thêm voice khác Ngân
1. **Multi-character podcast** — mỗi character 1 voice cloned, 1-2 phút mỗi character
2. **Foreign language content** — English voice cho khách quốc tế (vd: Adam, Antoni)
3. **A/B test brand voice** — test voice mới có outperform Ngân không

### Quy trình thêm voice mới
1. Clone voice qua ElevenLabs Instant Voice Clone (5 phút audio sample)
2. Test 5 sample TTS (Edge → STS) so với Ngân
3. Nếu pass admin review → set per-module override (vd `vs_elevenlabs_voice_id_english`)
4. KHÔNG ghi đè `vs_elevenlabs_voice_id_owner`

---

**LAST UPDATED**: 2026-05-04
**OWNER**: Sonder Brand Team
**REVIEW CYCLE**: Mỗi 6 tháng — verify voice consistency, update settings nếu ElevenLabs ra model mới
