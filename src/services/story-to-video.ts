/**
 * Story-to-Video v4 — REEL TRIỆU VIEW pipeline.
 *
 * 5 modules:
 *   A. 4-beat script (Claude 2-pass: hook + setup + build + payoff + cta)
 *   C. Visual sync per-beat (gen 5 ảnh CỤ THỂ matching từng beat)
 *   D. ASS subtitle dual-style (normal bottom + KEY popup yellow boom)
 *   E. Pacing (silent pauses + BGM volume ramp)
 *   F. Reel caption optimize (hook first + question CTA + 3 hashtags)
 *   B1 placeholder: Edge-TTS tweaked (sẽ swap B3 voice clone của user khi ready)
 *
 * Pipeline ~3-5 phút/video.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
import { db, getSetting } from '../db';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const SCENES_DIR = '/opt/vp-marketing/data/media/scenes';
const BRAND_DIR = '/opt/vp-marketing/data/brand';
const PUBLIC_BASE = 'https://app.sondervn.com';
const GRAPH = 'https://graph.facebook.com/v18.0';
const FPS = 30;

// ═══ V15: BRAND + CHARACTER PROFILE (cho continuity 8 tập) ═══

/** Sonder logo PNG path on VPS — overlay watermark mờ ở góc dưới-phải mọi scene. */
const SONDER_LOGO_PATH = `${BRAND_DIR}/sonder-logo.png`;

/** Nhân vật chính xuyên suốt 8 tập "Sài Gòn Tháng Năm".
 *  Inject vào Gemini visual prompt + Claude script context để giữ continuity. */
const CHARACTER_PROFILE = {
  name: 'Linh',
  age: 28,
  gender: 'female',
  backstory:
    'Linh, 28 tuổi, vừa rời Đà Nẵng sau 4 năm làm việc, về Sài Gòn để bắt đầu lại. ' +
    'Tính cách: trầm lặng, quan sát kỹ, nhạy cảm. Hay viết nhật ký, thích những khoảnh khắc nhỏ.',
  visualPrompt:
    // Tiếng Anh — cho Gemini Flash Image gen consistency
    'A young Vietnamese woman named Linh, 28 years old, with long straight black hair side-parted, ' +
    'gentle features, contemplative quiet expression. Wearing oversized white linen shirt, beige cotton pants, ' +
    'casual minimalist style. Often holds a small notebook and a glass of warm water. ' +
    'Soft cinematic warm lighting, intimate observational mood.',
  signature_props:
    'small notebook, glass of warm water, canvas tote bag, simple silver bracelet',
};

/** Series-level context cho Claude script gen — 8 tập story arc. */
const SERIES_CONTEXT =
  'Series "Sài Gòn Tháng Năm" gồm 8 tập về Linh — cô gái 28 tuổi vừa rời Đà Nẵng về Sài Gòn. ' +
  'Mỗi tập 1 lát cắt nhỏ trong những ngày đầu cô làm quen với thành phố mới. ' +
  'Tone: trầm, cảm xúc, ý nghĩa tự thành — không hard-sell, không mời gọi đặt phòng.';

// ─── ALTER table ─── add video columns if not exist
try {
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('story_episodes')`).all() as any[]).map(r => r.name);
  if (!cols.includes('video_url')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_url TEXT`);
  if (!cols.includes('video_excerpt')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_excerpt TEXT`);
  if (!cols.includes('video_published_to')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_published_to TEXT`);
  if (!cols.includes('video_status')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_status TEXT DEFAULT 'pending'`);
  if (!cols.includes('video_scheduled_at')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_scheduled_at INTEGER`);
  if (!cols.includes('video_script_json')) db.exec(`ALTER TABLE story_episodes ADD COLUMN video_script_json TEXT`);
  if (!cols.includes('reel_caption')) db.exec(`ALTER TABLE story_episodes ADD COLUMN reel_caption TEXT`);
} catch (e: any) { console.warn('[story-video] ALTER skip:', e?.message); }

if (!fs.existsSync(SCENES_DIR)) fs.mkdirSync(SCENES_DIR, { recursive: true });

// ─── Claude direct call ───
async function callClaude(system: string, user: string, maxTokens = 3000): Promise<string> {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not set');
  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 180_000,
    }
  );
  return ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
}

// ═══ MODULE A: 4-beat script generation ═══

type MoodTag = 'calm' | 'tense' | 'warm' | 'sad' | 'uplifting' | 'intimate';
type CameraAngle = 'wide' | 'medium' | 'close-up' | 'aerial' | 'pov';

interface ScriptScene {
  beat: 'hook' | 'setup' | 'build' | 'payoff' | 'cta';
  text: string;             // VN narration
  duration_sec: number;     // estimated
  visual_prompt: string;    // English image prompt (for AI image gen)
  visual_query: string;     // 3-5 specific English keywords for Pexels stock search
  mood: MoodTag;            // for BGM matcher
  camera: CameraAngle;
  is_key: boolean;          // popup emphasis
}

interface VideoScript {
  scenes: ScriptScene[];
}

const SCRIPT_SYSTEM = `Bạn là biên kịch Reel branding-storytelling cho series "Sài Gòn Tháng Năm". Phong cách: lát cắt cảm xúc, ý tự thành — KHÔNG hard-sell, KHÔNG mời đặt phòng.

Cho 1 caption Facebook dài, viết script video Reel 40-55s với 7-8 micro-scenes (mỗi scene 3-6 giây). Cut nhanh để giữ mắt audience Shorts gen Z, nhưng vẫn poetic + cinematic.

Cấu trúc 7-8 scenes (5 beat chính, 2-3 beat có thể chia 2 micro-scene):
1. [hook]     3-5s — shock/personal stake/time-decision
2. [setup]    3-5s — context (có thể chia 2 micro-scene = setup + setup)
3. [build]    3-5s — sensory detail (CHIA 2-3 micro-scenes để cut nhanh hơn)
4. [payoff]   3-5s — insight cathartic
5. [cta]      4-6s — câu hỏi/insight POETIC, KHÔNG action

✅ HOOK rules: 8-12 từ. 1 trong 3:
   - Personal stake + số ("32 tuổi nghỉ việc...")
   - Time-decision ("11 giờ đêm tôi nhận ra...")
   - Contradiction ("Tôi không tin chỗ này có thật...")
   ❌ KHÔNG mở bằng mô tả tĩnh.

✅ CTA rules (V15 — branding mềm): câu hỏi/insight poetic. VÍ DỤ:
   - "Đôi khi mình không cần đến đâu — chỉ cần một nơi biết đợi mình. Bạn đang dừng lại ở đâu tối nay?"
   - "Có những đêm thành phố hiền hơn mình nghĩ. Bạn có không?"
   ❌ KHÔNG: "Inbox để giữ phòng", "đặt ngay", "liên hệ", URL website.
   ❌ KHÔNG mention "Sonder", "khách sạn" trong text — branding "ý tự thành".

Voice rules: VN đời thường, POV ngôi 1 "mình" (= Linh). Câu ngắn 5-10 từ. Không "tự sự", "trải nghiệm".

Mỗi scene PHẢI có 7 fields:
- text: VN narration
- duration: số giây (3-6)
- visual_query: 3-5 ENGLISH keywords cho Pexels (BACKUP)
- visual_prompt: ENGLISH image prompt — BẮT BUỘC nhắc "Vietnamese woman 28 with long black hair" cho cảnh có nhân vật chính.
   - "Vietnamese setting", "Saigon at night", hoặc "Tan Son Nhat Vietnam"
   - Hành động + nhân vật (dùng "Vietnamese woman 28" cho Linh, "young Vietnamese male" cho NPCs nam)
   - Mood lighting + camera angle
   - Style: "cinematic editorial photography, shot on Sony A7, soft natural lighting, film grain"
   ❌ KHÔNG: tên Tây (Mary, John...), KHÔNG "luxury hotel" (dùng "small boutique Vietnamese guesthouse")
- mood: 1 trong 6 (calm | tense | warm | sad | uplifting | intimate)
- camera: 1 trong 5 (wide | medium | close-up | aerial | pov)
- key: true cho HOOK + PAYOFF + CTA, false cho SETUP + BUILD

OUTPUT FORMAT (CHÍNH XÁC, cho 7-8 scenes):
[[SCENE 1 hook]]
text: <VN narration>
duration: 4
visual_query: <keywords>
visual_prompt: <full prompt>
mood: tense
camera: medium
key: true
[[END SCENE 1]]

[[SCENE 2 setup]]
... đủ 7 fields ...
[[END SCENE 2]]

[[SCENE 3 setup]]
... (setup 2 micro-scene = chia làm 2 phần story)
[[END SCENE 3]]

[[SCENE 4 build]]
[[SCENE 5 build]]
[[SCENE 6 build]]   (build chia 2-3 micro-scene)

[[SCENE 7 payoff]]

[[SCENE 8 cta]]

Tổng 7-8 scenes. KHÔNG ít hơn 7. KHÔNG nhiều hơn 8.`;

function buildScriptUserPrompt(caption: string, episodeTitle: string, episodeBeat: string): string {
  return `${SERIES_CONTEXT}

# Nhân vật chính (BẮT BUỘC giữ liên tục — XUẤT HIỆN MỌI TẬP)
${CHARACTER_PROFILE.backstory}
Props đặc trưng: ${CHARACTER_PROFILE.signature_props}

# Tập hiện tại
Tập: ${episodeTitle} (Beat truyện: ${episodeBeat})

# Caption gốc đầy đủ
${caption}

Viết script Reel 35-45s với 5 scenes (hook/setup/build/payoff/cta) theo system prompt.
HOOK NHẤT THIẾT phải shock + 8-12 từ.

⚠️ LƯU Ý ĐỊNH HƯỚNG (V15 — branding mềm):
- Nhân vật xuyên suốt = Linh (28 tuổi, vừa rời ĐN về SG). POV ngôi 1 "mình" = Linh.
- KHÔNG hard-sell, KHÔNG mời đặt phòng, KHÔNG CTA "Inbox để giữ phòng".
- CTA cuối là 1 câu hỏi/insight POETIC, không action — vd "Đôi khi du lịch không phải đi đâu, mà là dừng lại đủ lâu" — KHÔNG đề cập đặt phòng/giữ phòng/Sonder Airport.
- Brand "ý tự thành" — không xuất hiện text "Sonder" trong narration.
- visual_prompt cho cảnh có người: nhắc đến "Linh" hoặc "Vietnamese woman 28 with long black hair" — giữ continuity.

KHÔNG output gì ngoài 5 khối [[SCENE ... END SCENE ...]].`;
}

function parseScript(raw: string): VideoScript {
  const validBeats: Array<ScriptScene['beat']> = ['hook', 'setup', 'build', 'payoff', 'cta'];
  const validMoods: MoodTag[] = ['calm', 'tense', 'warm', 'sad', 'uplifting', 'intimate'];
  const validCameras: CameraAngle[] = ['wide', 'medium', 'close-up', 'aerial', 'pov'];
  const scenes: ScriptScene[] = [];

  // V15: Robust parser — tìm TẤT CẢ marker `[[SCENE N beat]]`, cắt block bằng NEXT start marker
  // (không cần END marker). Tolerant với Claude quên đóng `[[END SCENE]]`.
  const startRe = /\[\[SCENE\s+(\d+)\s+([\w-]+)\]\]/g;
  const matches: Array<{ idx: number; sceneNum: number; beat: string; markerLen: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(raw)) !== null) {
    matches.push({
      idx: m.index,
      sceneNum: parseInt(m[1], 10),
      beat: (m[2] || '').toLowerCase().split('-')[0],
      markerLen: m[0].length,
    });
  }
  if (matches.length === 0) throw new Error('No [[SCENE N beat]] markers found');

  // Sort by scene number (in case Claude scrambled order)
  matches.sort((a, b) => a.sceneNum - b.sceneNum);

  for (let k = 0; k < matches.length; k++) {
    const cur = matches[k];
    const next = matches[k + 1];
    const blockStart = cur.idx + cur.markerLen;
    // Block end = next scene's start, OR find [[END SCENE N]] marker, OR end of text
    let blockEnd = next ? next.idx : raw.length;
    // Strip trailing [[END SCENE N]] if present
    const endMarker = new RegExp(`\\[\\[END\\s+SCENE\\s+${cur.sceneNum}\\]\\]`, 'i');
    const endMatch = raw.substring(blockStart, blockEnd).match(endMarker);
    if (endMatch && endMatch.index !== undefined) {
      blockEnd = blockStart + endMatch.index;
    }
    const block = raw.substring(blockStart, blockEnd).trim();

    const beat: ScriptScene['beat'] = (validBeats as string[]).includes(cur.beat)
      ? cur.beat as ScriptScene['beat']
      : 'setup';

    const textMatch = block.match(/^\s*text:\s*([\s\S]+?)(?=\n\s*duration:)/m);
    const durMatch = block.match(/^\s*duration:\s*([\d.]+)/m);
    const queryMatch = block.match(/^\s*visual_query:\s*(.+?)(?=\n)/m);
    const promptMatch = block.match(/^\s*visual_prompt:\s*([\s\S]+?)(?=\n\s*mood:)/m);
    const moodMatch = block.match(/^\s*mood:\s*(\w+)/m);
    const cameraMatch = block.match(/^\s*camera:\s*([\w-]+)/m);
    const keyMatch = block.match(/^\s*key:\s*(true|false)/im);

    if (!textMatch || !durMatch || !queryMatch || !promptMatch) {
      console.warn(`[parseScript] SCENE ${cur.sceneNum} (${beat}) missing fields — skip. block[:100]=${block.slice(0,100)}`);
      continue;
    }
    const moodRaw = (moodMatch?.[1] || '').toLowerCase().trim() as MoodTag;
    const cameraRaw = (cameraMatch?.[1] || '').toLowerCase().trim() as CameraAngle;
    scenes.push({
      beat,
      text: textMatch[1].trim(),
      duration_sec: parseFloat(durMatch[1]),
      visual_query: queryMatch[1].trim().replace(/[",.]/g, '').trim(),
      visual_prompt: promptMatch[1].trim(),
      mood: validMoods.includes(moodRaw) ? moodRaw : 'warm',
      camera: validCameras.includes(cameraRaw) ? cameraRaw : 'medium',
      is_key: !!keyMatch && /true/i.test(keyMatch[1]),
    });
  }
  if (scenes.length < 5) throw new Error(`Parsed only ${scenes.length} scenes — need ≥5`);
  return { scenes };
}

export async function generateScript(caption: string, episodeTitle: string, episodeBeat: string): Promise<VideoScript> {
  const raw = await callClaude(SCRIPT_SYSTEM, buildScriptUserPrompt(caption, episodeTitle, episodeBeat), 3500);
  return parseScript(raw);
}

// ═══ MODULE F: Reel caption optimization ═══

const REEL_CAPTION_SYSTEM = `Bạn viết caption FB Reel cho series branding-storytelling "Sài Gòn Tháng Năm". Phong cách: lyrical, ý tự thành — KHÔNG hard-sell, KHÔNG mời gọi.

CẤU TRÚC (V15 — branding mềm):

DÒNG 1: 1 câu mở mạnh, ≤12 từ (thumbnail). Thường là time + decision moment hoặc sensory detail.
DÒNG TRỐNG
2-3 dòng tiếp: lát cắt cảm xúc tiếp theo, đan xen voice + visual. Câu ngắn 6-12 từ. Mỗi dòng = 1 nhịp.
DÒNG TRỐNG
1 dòng kết: "— Sài Gòn Tháng Năm, tập [N]"

❌ KHÔNG: hashtag spam, "Inbox để giữ phòng", "đặt phòng", URL website.
❌ KHÔNG: mention "Sonder", "khách sạn" trong text.
❌ KHÔNG: CTA cứng ("Comment 'PHÒNG'", "Like nếu...", "Tag bạn bè").
❌ KHÔNG: emoji rườm rà — TỐI ĐA 1 emoji nhẹ ở dòng đầu (ví dụ "🌙" hoặc bỏ luôn).

✅ Voice: ngôi 1 "mình" (= Linh, 28t, vừa rời ĐN về SG). Thuần Việt, đời thường, không sến.
✅ Tổng caption: 80-200 chars (ngắn hơn V14 nhiều). Đặt audience tự fill khoảng trống.

VÍ DỤ chuẩn:

11 giờ đêm.
Mình vừa bỏ 4 năm lại Đà Nẵng.
Sài Gòn mình chưa có gì cả.

— Sài Gòn Tháng Năm, tập 1

OUTPUT: chỉ caption thuần, KHÔNG kèm giải thích, KHÔNG markdown, KHÔNG quote.`;

export async function generateReelCaption(hook: string, fullStoryCaption: string, episodeNo: number = 1): Promise<string> {
  const user = `# Hook (DÒNG 1, dùng nguyên văn)
${hook}

# Story gốc (chỉ tham khảo bối cảnh, KHÔNG copy)
${fullStoryCaption}

# Số tập
Tập ${episodeNo}

Viết caption FB Reel V15 (branding mềm) theo format. DÒNG 1 = hook nguyên văn. Kết bằng "— Sài Gòn Tháng Năm, tập ${episodeNo}". Tổng 80-200 chars.`;
  return await callClaude(REEL_CAPTION_SYSTEM, user, 400);
}

// ═══ MODULE C: Visual sync per-beat (Pexels VIDEO clip first, fallback Gemini IMAGE) ═══

interface SceneVisual {
  type: 'video' | 'image';
  path: string;            // local file path
  natural_duration: number; // for video: actual length; image: 0 (loop)
}

/** Fetch Pexels video clip using SCENE'S SPECIFIC visual_query (not generic).
 *  Tracks already-used clips in this video to avoid duplicates across scenes. */
const usedPexelsIds = new Set<string>();

async function fetchPexelsVideoClip(visualQuery: string, sceneIndex: number): Promise<{ path: string; duration: number; clipId: string } | null> {
  try {
    const { searchPexels } = require('./video-studio/providers/pexels');
    const query = (visualQuery || '').trim();
    if (!query || query.length < 5) {
      console.log(`[story-video] Pexels skip (query too short): "${query}"`);
      return null;
    }

    const clips = await searchPexels(query, {
      orientation: 'portrait',
      perPage: 8,
      minDuration: 3,
    });
    if (!clips || clips.length === 0) return null;

    // Pick first clip that hasn't been used yet in this video
    let clip = clips.find((c: any) => !usedPexelsIds.has(String(c.id)));
    if (!clip) clip = clips[0];  // all used, fallback to first
    usedPexelsIds.add(String(clip.id));

    const filename = `pexels-${clip.id}.mp4`;
    const localPath = path.join(SCENES_DIR, filename);

    if (!fs.existsSync(localPath)) {
      const resp = await axios.get(clip.clip_url, {
        responseType: 'arraybuffer',
        timeout: 90_000,
        maxContentLength: 50 * 1024 * 1024,
      });
      fs.writeFileSync(localPath, Buffer.from(resp.data));
      console.log(`[story-video] Pexels "${query.slice(0, 40)}": ${(resp.data.length/1024/1024).toFixed(1)}MB, ${clip.duration_sec}s`);
    } else {
      console.log(`[story-video] Pexels "${query.slice(0, 40)}": cached`);
    }

    return { path: localPath, duration: clip.duration_sec, clipId: String(clip.id) };
  } catch (e: any) {
    console.warn('[story-video] Pexels fetch fail:', e?.message);
    return null;
  }
}

/** Fallback: Gemini Flash Image */
async function generateImageForScene(prompt: string): Promise<string | null> {
  try {
    const { generateImageSmart } = require('./imagegen');
    const fullPrompt = `${prompt}, cinematic editorial photography, Vietnam Saigon setting, no faces visible, film grain, shot on Sony A7, soft natural lighting, magazine quality | negative: text, watermark, logo, blurry, distorted face, low quality, cartoon`;
    const r = await generateImageSmart(fullPrompt);
    const mediaRow = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(r.mediaId) as any;
    if (!mediaRow) return null;
    const isUrl = /^https?:\/\//i.test(mediaRow.filename);
    return isUrl ? mediaRow.filename : path.join(MEDIA_DIR, mediaRow.filename);
  } catch (e: any) {
    console.warn('[story-video] image gen fail:', e?.message);
    return null;
  }
}

/** MIX images + videos cho phân cảnh đa dạng theo beat:
 *  - hook: image (controlled, specific personal stake — close-up VN)
 *  - setup: image (people/scene with characters — VN specific)
 *  - build: video (B-roll wide motion — environment immersion)
 *  - payoff: video (aerial/cinematic — emotional peak)
 *  - cta: image (close-up cozy controlled)
 *
 *  Image scenes: AI Gemini Flash (Vietnamese context).
 *  Video scenes: Pexels stock (motion B-roll).
 *  Cross-fallback nếu fail. */
async function fetchVisualForScene(scene: ScriptScene, sceneIndex: number): Promise<SceneVisual> {
  // Heuristic: build + payoff prefer video (motion B-roll), others prefer image
  const preferVideo = scene.beat === 'build' || scene.beat === 'payoff';

  // Enhanced VN prompt for image gen
  const moodLight = {
    tense: 'dramatic moody lighting, blue tones',
    warm: 'warm golden lamp lighting',
    sad: 'melancholic blue cool tones',
    uplifting: 'bright hopeful natural light',
    intimate: 'soft warm intimate lighting',
    calm: 'soft balanced natural light',
  }[scene.mood];
  const cameraDesc = {
    'close-up': 'close-up detail shot',
    'wide': 'wide cinematic establishing shot',
    'medium': 'medium shot',
    'aerial': 'aerial bird-eye view',
    'pov': 'first-person POV through window',
  }[scene.camera];
  // V15: Inject character profile để giữ continuity 8 tập (Linh — same person each ep)
  // Chỉ inject nếu scene có chỗ có người (close-up/medium shot, không phải aerial/wide cảnh phòng)
  const sceneHasPerson = scene.camera === 'close-up' || scene.camera === 'medium' ||
                         /người|cô|anh|cầm|đứng|ngồi|tay/.test(scene.text.toLowerCase());
  const characterClause = sceneHasPerson
    ? `, featuring ${CHARACTER_PROFILE.visualPrompt}`
    : '';
  const enhancedPrompt = `${scene.visual_prompt}, Vietnamese setting, authentic Saigon atmosphere${characterClause}, ${cameraDesc}, ${moodLight}, no Western faces, cinematic editorial photography, shot on Sony A7, soft natural lighting, magazine quality | negative: text, watermark, blurry, distorted face, cartoon, oversaturated`;

  if (preferVideo) {
    // PRIORITY: Pexels video for motion B-roll
    const video = await fetchPexelsVideoClip(scene.visual_query, sceneIndex);
    if (video) {
      console.log(`[story-video] visual=video (Pexels) — ${scene.beat} prefers motion`);
      return { type: 'video', path: video.path, natural_duration: video.duration };
    }
    // Fallback to AI image
    try {
      const img = await generateImageForScene(enhancedPrompt);
      if (img) {
        console.log(`[story-video] visual=image (AI fallback) — Pexels miss`);
        return { type: 'image', path: img, natural_duration: 0 };
      }
    } catch (e: any) {
      console.warn('[story-video] AI image fallback fail:', e?.message);
    }
  } else {
    // PRIORITY: AI image (controlled VN context)
    try {
      const img = await generateImageForScene(enhancedPrompt);
      if (img) {
        console.log(`[story-video] visual=image (AI) — ${scene.beat} prefers controlled VN`);
        return { type: 'image', path: img, natural_duration: 0 };
      }
    } catch (e: any) {
      console.warn('[story-video] AI image fail:', e?.message);
    }
    // Fallback to Pexels
    const video = await fetchPexelsVideoClip(scene.visual_query, sceneIndex);
    if (video) {
      console.log(`[story-video] visual=video (Pexels fallback)`);
      return { type: 'video', path: video.path, natural_duration: video.duration };
    }
  }

  throw new Error('no visual for scene');
}

// ═══ MODULE 6 ENHANCEMENTS: Intro + Outro frames ═══

const INTRO_DURATION = 2.8;
const OUTRO_DURATION = 3.5;

/** Generate intro video MP4 với drawtext + dark gradient bg + silent audio */
async function generateIntroFrame(opts: {
  brandTitle: string;
  episodeTitle: string;
  outputPath: string;
}): Promise<void> {
  const bg = '0x1a1a2e';
  const accent = '0xff8c42';
  const dur = INTRO_DURATION;

  // Escape single quotes for FFmpeg
  const esc = (s: string) => s.replace(/['"]/g, '');
  const t1 = esc(opts.brandTitle);
  const t2 = esc(opts.episodeTitle);

  // Fade alpha: ease-in 0.5s, hold middle, ease-out 0.5s
  const alphaExpr = (delay: number) => `if(lt(t\\,${delay}),0,if(lt(t\\,${delay + 0.5}),(t-${delay})*2,if(lt(t\\,${dur - 0.5}),1,(${dur} - t)*2)))`;

  const drawText1 = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${t1}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=600:alpha='${alphaExpr(0)}'`;
  const drawText2 = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${t2}':fontsize=44:fontcolor=${accent}:x=(w-text_w)/2:y=900:alpha='${alphaExpr(0.3)}'`;
  // Subtle line accent
  const drawLine = `drawbox=x=(w-200)/2:y=820:w=200:h=3:color=${accent}@0.6:t=fill:enable='between(t,0.5,${dur - 0.5})'`;

  const args = [
    '-f', 'lavfi', '-i', `color=c=${bg}:s=1080x1920:d=${dur}:r=30`,
    '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', `${drawText1},${drawText2},${drawLine},vignette=PI/4`,
    '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    '-y', opts.outputPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('intro gen fail: ' + (r.stderr || '').slice(-500));
}

/** Generate outro video MP4 với closing line + brand */
async function generateOutroFrame(opts: {
  closingLine: string;
  brand: string;
  cta: string;
  outputPath: string;
}): Promise<void> {
  const bg = '0x1a1a2e';
  const accent = '0xff8c42';
  const dur = OUTRO_DURATION;

  const esc = (s: string) => s.replace(/['"]/g, '');
  const t1 = esc(opts.closingLine);
  const t2 = esc(opts.brand);
  const t3 = esc(opts.cta);

  const alphaExpr = (delay: number) => `if(lt(t\\,${delay}),0,if(lt(t\\,${delay + 0.5}),(t-${delay})*2,if(lt(t\\,${dur - 0.6}),1,(${dur} - t)*1.6)))`;

  // Closing italic-like (no italic font, use bold)
  const drawClosing = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${t1}':fontsize=46:fontcolor=white:x=(w-text_w)/2:y=620:line_spacing=12:box=1:boxcolor=black@0.0:alpha='${alphaExpr(0)}'`;
  const drawBrand = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${t2}':fontsize=64:fontcolor=${accent}:x=(w-text_w)/2:y=1100:alpha='${alphaExpr(0.6)}'`;
  const drawCta = `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${t3}':fontsize=36:fontcolor=white@0.85:x=(w-text_w)/2:y=1220:alpha='${alphaExpr(1.0)}'`;
  const drawLine = `drawbox=x=(w-200)/2:y=1080:w=200:h=3:color=${accent}@0.6:t=fill:enable='between(t,0.6,${dur - 0.5})'`;

  const args = [
    '-f', 'lavfi', '-i', `color=c=${bg}:s=1080x1920:d=${dur}:r=30`,
    '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', `${drawClosing},${drawLine},${drawBrand},${drawCta},vignette=PI/4`,
    '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    '-y', opts.outputPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('outro gen fail: ' + (r.stderr || '').slice(-500));
}

/** Generate silent audio mp3 for intro/outro */
async function generateSilentAudio(durationSec: number, outputPath: string): Promise<void> {
  const args = [
    '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-y', outputPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('silent gen fail');
}

// ═══ MODULE 5: Mood-aware BGM selector ═══

const BGM_MOOD_LIBRARY: Record<MoodTag, string> = {
  calm: '/opt/vp-marketing/data/bgm/mood_calm.mp3',
  tense: '/opt/vp-marketing/data/bgm/mood_tense.mp3',
  warm: '/opt/vp-marketing/data/bgm/mood_warm.mp3',
  sad: '/opt/vp-marketing/data/bgm/mood_sad.mp3',
  uplifting: '/opt/vp-marketing/data/bgm/mood_uplifting.mp3',
  intimate: '/opt/vp-marketing/data/bgm/mood_intimate.mp3',
};

function selectBgmForVideo(scenes: ScriptScene[]): string {
  // Aggregate moods, weight by duration
  const moodScore: Record<string, number> = {};
  for (const sc of scenes) {
    moodScore[sc.mood] = (moodScore[sc.mood] || 0) + sc.duration_sec;
  }
  // Pick dominant mood, but prefer the PAYOFF scene mood (emotional peak)
  const payoffMood = scenes.find(s => s.beat === 'payoff')?.mood;
  const dominantMood = (Object.entries(moodScore).sort((a, b) => b[1] - a[1])[0]?.[0] || 'warm') as MoodTag;
  const chosenMood: MoodTag = (payoffMood && BGM_MOOD_LIBRARY[payoffMood]) ? payoffMood : dominantMood;
  const candidatePath = BGM_MOOD_LIBRARY[chosenMood];
  if (candidatePath && fs.existsSync(candidatePath)) {
    console.log(`[story-video] BGM mood: ${chosenMood} (payoff=${payoffMood}, dominant=${dominantMood}) → ${path.basename(candidatePath)}`);
    return candidatePath;
  }
  // Fallback to default
  const defaultPath = '/opt/vp-marketing/data/bgm/sonder-soft.mp3';
  console.log(`[story-video] BGM mood ${chosenMood} not in library, fallback default`);
  return defaultPath;
}

// ═══ TTS — Edge-TTS tweaked (B1 placeholder, swap to B3 voice clone when user ready) ═══

interface TTSResult { audioPath: string; subtitlePath?: string; }

async function synthesizeVoiceForScene(text: string, sceneIndex: number): Promise<TTSResult> {
  const ts = Date.now() + sceneIndex;
  const audioPath = path.join(MEDIA_DIR, `voice-scene-${ts}.mp3`);
  const subPath = path.join(MEDIA_DIR, `voice-scene-${ts}.srt`);

  // ═══ STEP 1: Edge-TTS gen reference audio (chuẩn VN) — with retry ═══
  const voice = getSetting('vs_edge_tts_voice') || 'vi-VN-HoaiMyNeural';
  const rate = getSetting('vs_edge_tts_rate') || '-3%';
  const pitch = getSetting('vs_edge_tts_pitch') || '+3Hz';
  const edgeRefPath = path.join(MEDIA_DIR, `edge-ref-${ts}.mp3`);
  let lastErr: any = null;
  let edgeOk = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = spawnSync('python3', [
        '-m', 'edge_tts',
        `--voice=${voice}`,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        `--text`, text,
        `--write-media`, edgeRefPath,
        `--write-subtitles`, subPath,
      ], { encoding: 'utf8', timeout: 180_000 });
      if (r.status !== 0) throw new Error('edge-tts: ' + (r.stderr || '').slice(-200));
      if (!fs.existsSync(edgeRefPath) || fs.statSync(edgeRefPath).size < 1000) throw new Error('empty edge audio');
      edgeOk = true;
      break;
    } catch (e: any) {
      lastErr = e;
      if (attempt < 4) {
        const backoff = attempt * 2;
        console.warn(`[story-video] edge-tts attempt ${attempt} fail, retry in ${backoff}s:`, e?.message?.slice(0, 100));
        await new Promise(r => setTimeout(r, backoff * 1000));
      }
    }
  }
  if (!edgeOk) throw new Error('edge-tts after 4 retries: ' + (lastErr?.message || 'unknown'));
  const hasSub = fs.existsSync(subPath) && fs.statSync(subPath).size > 50;

  // ═══ STEP 2: STS convert Edge → ElevenLabs Ngan voice (natural human-like) ═══
  const ngangVoiceId = getSetting('vs_elevenlabs_voice_id_owner');
  const elKey = getSetting('elevenlabs_api_key') || getSetting('vs_elevenlabs_api_key');
  if (ngangVoiceId && elKey) {
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('audio', fs.createReadStream(edgeRefPath), { filename: 'source.mp3', contentType: 'audio/mpeg' });
      form.append('model_id', 'eleven_multilingual_sts_v2');
      form.append('voice_settings', JSON.stringify({ stability: 0.5, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true }));
      const resp = await axios.post(
        `https://api.elevenlabs.io/v1/speech-to-speech/${ngangVoiceId}`,
        form,
        {
          headers: { 'xi-api-key': elKey, ...form.getHeaders(), 'Accept': 'audio/mpeg' },
          responseType: 'arraybuffer',
          timeout: 180_000,
          maxContentLength: 50 * 1024 * 1024,
        }
      );
      fs.writeFileSync(audioPath, Buffer.from(resp.data));
      // Cleanup edge ref
      try { fs.unlinkSync(edgeRefPath); } catch {}
      console.log(`[story-video] TTS: edge-ref → STS Ngan (natural voice + VN pronunciation)`);
      return { audioPath, subtitlePath: hasSub ? subPath : undefined };
    } catch (e: any) {
      console.warn('[story-video] STS fail, fallback Edge audio:', e?.response?.status, e?.message);
    }
  }

  // FALLBACK: Use Edge audio directly (clean robotic but accurate VN)
  fs.copyFileSync(edgeRefPath, audioPath);
  try { fs.unlinkSync(edgeRefPath); } catch {}
  console.log(`[story-video] TTS-FALLBACK: edge-tts ${voice} (no STS)`);
  return { audioPath, subtitlePath: hasSub ? subPath : undefined };
}

// ═══ MODULE D: ASS subtitle với KEY popup ═══

function buildAssSubtitle(
  scenes: ScriptScene[],
  sceneStartTimes: number[],
  outputPath: string
): void {
  // ASS file format with 2 styles: Normal (small bottom) + Key (large center yellow boom)
  const lines: string[] = [];
  lines.push('[Script Info]');
  lines.push('Title: Story Reel Subtitle');
  lines.push('ScriptType: v4.00+');
  lines.push('PlayResX: 1080');
  lines.push('PlayResY: 1920');
  lines.push('');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV');
  // Normal: white text, black outline, bottom (Alignment 2 = bottom-center), margin 200 from bottom
  lines.push('Style: Normal,DejaVu Sans,40,&H00FFFFFF,&H00000000,&H80000000,1,1,3,1,2,80,80,200');
  // Key: yellow text, thick black outline, CENTER (Alignment 5)
  lines.push('Style: Key,DejaVu Sans,72,&H0000FFFF,&H00000000,&HC0000000,1,1,4,2,5,80,80,0');
  lines.push('');
  lines.push('[Events]');
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const start = sceneStartTimes[i];
    const sceneDur = sc.duration_sec;
    const style = sc.is_key ? 'Key' : 'Normal';

    // V15: Auto-split text vào multiple chunks chronological (max 2 lines, ~14 chars/line)
    // Mỗi chunk = 1 sub event riêng, chia đều thời gian theo độ dài text
    const chunks = splitIntoSubChunks(sc.text);
    if (chunks.length === 0) continue;
    const totalChars = chunks.reduce((s, c) => s + c.length, 0);
    let cursor = start;
    for (const chunk of chunks) {
      // Time proportional to chunk length, min 0.8s, max 3s per chunk
      const proportional = (chunk.length / totalChars) * sceneDur;
      const chunkDur = Math.min(3.0, Math.max(0.8, proportional));
      const chunkEnd = Math.min(cursor + chunkDur, start + sceneDur);
      const wrapped = wrapText(chunk, 18).slice(0, 2).join('\\N');  // V15: max 2 lines, 18 chars
      const tagPrefix = sc.is_key
        ? '{\\fad(150,200)\\t(0,300,\\fscx115\\fscy115)\\t(300,1000,\\fscx100\\fscy100)}'
        : '{\\fad(150,150)}';
      lines.push(`Dialogue: 0,${formatAssTime(cursor)},${formatAssTime(chunkEnd)},${style},,0,0,0,,${tagPrefix}${wrapped}`);
      cursor = chunkEnd;
      if (cursor >= start + sceneDur) break;
    }
  }

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
}

/** V15: Split scene text vào multiple sub chunks (chronological).
 *  Strategy: split tại punctuation boundaries (. , — ! ?).
 *  Mỗi chunk ngắn (≤30 chars ideal, ≤45 chars max). */
function splitIntoSubChunks(text: string): string[] {
  if (!text) return [];
  // Step 1: split tại major punctuation
  const major = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  // Step 2: trong mỗi major chunk, nếu quá dài, split tiếp tại comma/dash
  const out: string[] = [];
  for (const m of major) {
    if (m.length <= 35) {
      out.push(m.trim());
    } else {
      // Split tại , — :
      const minor = m.split(/[,—:]\s+/).map(s => s.trim()).filter(s => s);
      if (minor.length === 1) {
        // Không có punctuation phụ — split tại space ~30 chars
        const words = m.split(/\s+/);
        let cur = '';
        for (const w of words) {
          if ((cur + ' ' + w).trim().length > 30) {
            if (cur) out.push(cur.trim());
            cur = w;
          } else cur = cur ? cur + ' ' + w : w;
        }
        if (cur) out.push(cur.trim());
      } else {
        out.push(...minor);
      }
    }
  }
  return out.filter(s => s.length > 0);
}

function formatAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function wrapText(text: string, maxLen: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxLen) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur.trim());
  return lines.slice(0, 3);  // max 3 lines per scene
}

// ═══ MODULE E: FFmpeg compose with pacing ═══

function ffprobeDuration(filePath: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
  ], { encoding: 'utf8' });
  return parseFloat(r.stdout.trim()) || 0;
}

/** Render a SINGLE scene to its own MP4 with full cinematic filter chain.
 *  Audio pad/trim to exact duration. V15: thêm Sonder watermark mờ ở góc dưới-phải.
 *  Returns mp4 path. */
async function renderSingleScene(opts: {
  visual: SceneVisual;
  audioPath: string;
  duration: number;
  fadeInDur?: number;
  fadeOutDur?: number;
  outputPath: string;
  noWatermark?: boolean;     // V15: skip watermark (vd cho intro/outro card đã có brand)
}): Promise<void> {
  const { visual, audioPath, duration, outputPath } = opts;
  const fadeIn = opts.fadeInDur ?? 0.6;
  const fadeOut = opts.fadeOutDur ?? 0.6;

  const cineGrade = `eq=saturation=1.06,curves=r='0/0.12 0.5/0.55 1/0.98':g='0/0.10 0.5/0.5 1/0.97':b='0/0.14 0.5/0.5 1/0.94'`;
  const filmGrain = `noise=alls=4:allf=t`;
  const vignette = `vignette=PI/4`;

  let videoFilter: string;
  let inputArgs: string[];

  if (visual.type === 'video') {
    inputArgs = ['-stream_loop', '-1', '-t', duration.toFixed(3), '-i', visual.path];
    videoFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setpts=PTS-STARTPTS,fps=${FPS},${cineGrade},${filmGrain},${vignette},fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(duration - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0[outv_pre]`;
  } else {
    const frames = Math.max(1, Math.round(duration * FPS));
    inputArgs = ['-framerate', String(FPS), '-loop', '1', '-t', duration.toFixed(3), '-i', visual.path];
    videoFilter = `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,zoompan=z='min(zoom+0.0010,1.20)':d=${frames}:s=1080x1920:fps=${FPS},setpts=PTS-STARTPTS,${cineGrade},${filmGrain},${vignette},fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(duration - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0[outv_pre]`;
  }

  // ─── V15: Sonder watermark overlay ở góc dưới-phải (CONSTANT 0.35 alpha) ───
  // Logo 80x80, position bottom-right padding 30/60
  // colorkey strip white bg → format rgba → colorchannelmixer aa=0.35 (constant alpha, KHÔNG fade alpha
  //   vì fade=alpha=1 sẽ OVERRIDE colorkey transparency, làm watermark biến mất)
  const useWatermark = !opts.noWatermark && fs.existsSync(SONDER_LOGO_PATH);
  if (useWatermark) {
    inputArgs.push('-i', SONDER_LOGO_PATH);
    videoFilter += `;[1:v]colorkey=0xFFFFFF:0.10:0.05,scale=80:80,format=rgba,colorchannelmixer=aa=0.35[wm];[outv_pre][wm]overlay=W-w-30:H-h-60[outv]`;
  } else {
    videoFilter += `;[outv_pre]copy[outv]`;
  }

  // Audio: pad with silence then trim → exact duration (avoids short-stream cut)
  // V15: dynamic audio input index — nếu có watermark, audio là input 2; không có thì 1
  const audioInputIdx = useWatermark ? 2 : 1;
  const audioFilter = `[${audioInputIdx}:a]aresample=48000,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;

  const args = [
    ...inputArgs,
    '-i', audioPath,
    '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2),  // GOP=2s for clean cuts
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', duration.toFixed(3),
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
    throw new Error('renderScene fail: ' + errTail);
  }
}

async function composeMultiSceneVideo(opts: {
  scenes: ScriptScene[];
  sceneAudios: string[];        // mp3 paths per scene
  sceneVisuals: SceneVisual[];  // video OR image per scene (mixed)
  bgmPath?: string;
  assSubtitlePath: string;
  outputPath: string;
}): Promise<{ outputPath: string; duration: number; sceneStartTimes: number[] }> {
  const { scenes, sceneAudios, sceneVisuals, bgmPath, assSubtitlePath, outputPath } = opts;
  const N = scenes.length;
  if (sceneAudios.length !== N || sceneVisuals.length !== N) throw new Error('scenes/audios/visuals length mismatch');

  // ─── 1. Compute durations (audio + silent pause per beat) ───
  const SILENCE_AFTER_HOOK = 0.6;
  const SILENCE_BEFORE_PAYOFF = 0.4;
  const sceneStartTimes: number[] = [];
  const sceneDurations: number[] = [];
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const audioDur = ffprobeDuration(sceneAudios[i]);
    let pauseAfter = 0;
    if (scenes[i].beat === 'hook') pauseAfter = SILENCE_AFTER_HOOK;
    if (scenes[i].beat === 'build' && i + 1 < N && scenes[i + 1].beat === 'payoff') pauseAfter = SILENCE_BEFORE_PAYOFF;
    sceneStartTimes.push(cursor);
    const totalSceneDur = audioDur + pauseAfter;
    sceneDurations.push(totalSceneDur);
    cursor += totalSceneDur;
  }
  const totalDur = cursor;

  // ─── 2. Render each scene to its own MP4 (cinematic filter + voice audio embedded) ───
  // Per-scene render avoids the FFmpeg multi-input concat bug that crushed
  // scenes 3-6 to black (YAVG ~2-5) in v12/v13.
  const ts = Date.now();
  const sceneMp4s: string[] = [];
  for (let i = 0; i < N; i++) {
    const sceneOut = path.join(SCENES_DIR, `scene-${ts}-${i}.mp4`);
    console.log(`[story-video]   scene ${i + 1}/${N} render (${sceneVisuals[i].type}, ${sceneDurations[i].toFixed(2)}s)...`);
    await renderSingleScene({
      visual: sceneVisuals[i],
      audioPath: sceneAudios[i],
      duration: sceneDurations[i],
      outputPath: sceneOut,
    });
    sceneMp4s.push(sceneOut);
  }

  // ─── 3. Write concat list file ───
  const concatListPath = path.join(SCENES_DIR, `concat-${ts}.txt`);
  const listContent = sceneMp4s
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, listContent);

  // ─── 4. Final pass: concat → ASS subtitle burn → voice EQ → BGM mix with sidechain ducking ───
  const inputs: string[] = ['-f', 'concat', '-safe', '0', '-i', concatListPath];
  let BGM_IDX: number | null = null;
  if (bgmPath && fs.existsSync(bgmPath)) {
    inputs.push('-stream_loop', '-1', '-i', bgmPath);
    BGM_IDX = 1;
  }

  const filters: string[] = [];

  // Video: ASS subtitle burn-in over the concat'd stream
  const escSub = assSubtitlePath.replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/,/g, '\\,');
  filters.push(`[0:v]ass='${escSub}'[outv]`);

  // Audio: voice EQ + (optional) BGM duck
  let audioOut = '[outa_voice]';
  if (BGM_IDX !== null) {
    filters.push(
      `[0:a]equalizer=f=120:t=q:w=2:g=-3,equalizer=f=2400:t=q:w=2:g=2,equalizer=f=4500:t=q:w=2:g=1,acompressor=threshold=0.1:ratio=3:attack=20:release=200,asplit=2[voice_main][voice_sc]`,
      `[${BGM_IDX}:a]volume=0.30,afade=t=in:st=0:d=1.5,afade=t=out:st=${(totalDur - 2).toFixed(2)}:d=2[bgm_pre]`,
      `[bgm_pre][voice_sc]sidechaincompress=threshold=0.04:ratio=8:attack=5:release=250:level_sc=1[bgm_ducked]`,
      `[voice_main][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0:weights=1.0 0.85[outa]`
    );
    audioOut = '[outa]';
  } else {
    filters.push(
      `[0:a]equalizer=f=120:t=q:w=2:g=-3,equalizer=f=2400:t=q:w=2:g=2,equalizer=f=4500:t=q:w=2:g=1,acompressor=threshold=0.1:ratio=3:attack=20:release=200[outa_voice]`
    );
  }

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-map', audioOut,
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', totalDur.toFixed(2),
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-50).join('\n');
    // Cleanup before throwing
    try { fs.unlinkSync(concatListPath); } catch {}
    for (const m of sceneMp4s) try { fs.unlinkSync(m); } catch {}
    throw new Error('ffmpeg final-pass fail: ' + errTail);
  }

  // ─── 5. Cleanup intermediate scene MP4s + concat list ───
  try { fs.unlinkSync(concatListPath); } catch {}
  for (const m of sceneMp4s) try { fs.unlinkSync(m); } catch {}

  return { outputPath, duration: totalDur, sceneStartTimes };
}

// ═══ FB Publish ═══

async function publishFbVideo(
  pageId: string, accessToken: string, videoUrl: string, description: string
): Promise<{ id: string }> {
  const resp = await axios.post(
    `${GRAPH}/${pageId}/videos`,
    null,
    {
      params: { file_url: videoUrl, description, access_token: accessToken },
      timeout: 240_000,
    }
  );
  return { id: resp.data.id };
}

// ═══ MAIN ENTRY ═══

export async function generateAndPublishVideo(
  seriesId: number, episodeNo: number, opts: { skipPublish?: boolean } = {}
): Promise<any> {
  const ep = db.prepare(
    `SELECT id, episode_no, title, beat, caption, image_url, video_status FROM story_episodes WHERE series_id = ? AND episode_no = ?`
  ).get(seriesId, episodeNo) as any;
  if (!ep) return { ok: false, error: 'episode not found' };

  let scriptObj: VideoScript | null = null;
  const tempFiles: string[] = [];

  try {
    db.prepare(`UPDATE story_episodes SET video_status = 'generating' WHERE id = ?`).run(ep.id);

    // ─── Module A: 4-beat script ───
    console.log(`[story-video] ep${episodeNo} Module A: gen script...`);
    scriptObj = await generateScript(ep.caption, ep.title || `Tập ${episodeNo}`, ep.beat || '');
    console.log(`[story-video] script: ${scriptObj.scenes.length} scenes (${scriptObj.scenes.map(s => `${s.beat}:${s.text.length}c`).join(', ')})`);
    db.prepare(`UPDATE story_episodes SET video_script_json = ? WHERE id = ?`).run(JSON.stringify(scriptObj), ep.id);

    // ─── Module C: visuals per-beat (Pexels VIDEO via scene query, fallback Gemini IMAGE) ───
    console.log(`[story-video] Module C: gen ${scriptObj.scenes.length} visuals...`);
    usedPexelsIds.clear();  // Reset per video
    const sceneVisuals: SceneVisual[] = [];
    for (let i = 0; i < scriptObj.scenes.length; i++) {
      const sc = scriptObj.scenes[i];
      console.log(`[story-video]   visual ${i + 1}/${scriptObj.scenes.length} (${sc.beat}, ${sc.mood}, ${sc.camera}): query="${sc.visual_query}"`);
      try {
        const v = await fetchVisualForScene(sc, i);
        sceneVisuals.push(v);
        console.log(`[story-video]     → ${v.type} (${path.basename(v.path)})`);
      } catch (e: any) {
        sceneVisuals.push({
          type: 'image',
          path: path.join(MEDIA_DIR, (ep.image_url || '').replace('/media/', '')),
          natural_duration: 0,
        });
        console.log(`[story-video]     → fallback story image`);
      }
    }

    // ─── TTS per scene ───
    console.log(`[story-video] TTS ${scriptObj.scenes.length} segments...`);
    const sceneAudios: string[] = [];
    for (let i = 0; i < scriptObj.scenes.length; i++) {
      const r = await synthesizeVoiceForScene(scriptObj.scenes[i].text, i);
      sceneAudios.push(r.audioPath);
      tempFiles.push(r.audioPath);
      if (r.subtitlePath) tempFiles.push(r.subtitlePath);
    }

    // ─── Module D: ASS subtitle (will compute timings inside compose) ───
    // Build ASS placeholder; recompute after compose returns sceneStartTimes
    // Actually we need to compute durations BEFORE composing. Let me precompute:
    const sceneStartTimes: number[] = [];
    let cursor = 0;
    for (let i = 0; i < scriptObj.scenes.length; i++) {
      const audioDur = ffprobeDuration(sceneAudios[i]);
      // Override duration_sec with actual audio length
      scriptObj.scenes[i].duration_sec = audioDur;
      sceneStartTimes.push(cursor);
      let pauseAfter = 0;
      if (scriptObj.scenes[i].beat === 'hook') pauseAfter = 0.6;
      if (scriptObj.scenes[i].beat === 'build' && i + 1 < scriptObj.scenes.length && scriptObj.scenes[i + 1].beat === 'payoff') pauseAfter = 0.4;
      cursor += audioDur + pauseAfter;
    }

    const assPath = path.join(MEDIA_DIR, `subs-${Date.now()}.ass`);
    buildAssSubtitle(scriptObj.scenes, sceneStartTimes, assPath);
    tempFiles.push(assPath);
    console.log(`[story-video] Module D: ASS subtitle built (${scriptObj.scenes.filter(s => s.is_key).length} key scenes)`);

    // ─── Generate Intro + Outro frames ───
    console.log(`[story-video] Module E: gen intro + outro frames...`);
    const series = db.prepare(`SELECT title, month_slug FROM story_series WHERE id = ?`).get(seriesId) as any;
    const tsId = Date.now();
    const introPath = path.join(MEDIA_DIR, `intro-${tsId}.mp4`);
    const outroPath = path.join(MEDIA_DIR, `outro-${tsId}.mp4`);
    const silentIntroAudio = path.join(MEDIA_DIR, `silent-intro-${tsId}.mp3`);
    const silentOutroAudio = path.join(MEDIA_DIR, `silent-outro-${tsId}.mp3`);
    // V15 Phase A: COLD OPEN — bỏ intro card text-heavy, hook scene mở video luôn
    // Outro card SOFTENED — chỉ closing line + brand text nhẹ, KHÔNG CTA "Inbox"
    try {
      await generateOutroFrame({
        closingLine: 'Đôi khi mình không cần đến đâu —\nchỉ cần một nơi biết đợi mình.',
        brand: 'Sài Gòn Tháng Năm',  // Series name, không phải brand cứng
        cta: '',  // V15: bỏ CTA
        outputPath: outroPath,
      });
      await generateSilentAudio(OUTRO_DURATION, silentOutroAudio);
      tempFiles.push(outroPath, silentOutroAudio);
      console.log(`[story-video]   ✓ outro ${OUTRO_DURATION}s ready (cold open, no intro)`);
    } catch (e: any) {
      console.warn('[story-video] outro gen fail (proceed without):', e?.message);
    }

    // Cold open: hook scene mở đầu video. Outro vẫn ở cuối.
    const fullScenes: ScriptScene[] = [];
    const fullVisuals: SceneVisual[] = [];
    const fullAudios: string[] = [];
    fullScenes.push(...scriptObj.scenes);
    fullVisuals.push(...sceneVisuals);
    fullAudios.push(...sceneAudios);
    if (fs.existsSync(outroPath) && fs.existsSync(silentOutroAudio)) {
      fullScenes.push({
        beat: 'cta' as any, text: '', visual_query: '', visual_prompt: '',
        mood: scriptObj.scenes[scriptObj.scenes.length - 1].mood,
        camera: scriptObj.scenes[scriptObj.scenes.length - 1].camera,
        duration_sec: OUTRO_DURATION, is_key: false,
      });
      fullVisuals.push({ type: 'video', path: outroPath, natural_duration: OUTRO_DURATION });
      fullAudios.push(silentOutroAudio);
    }

    // Rebuild ASS subtitle — story scenes start at 0 (no intro offset)
    const offsetStartTimes: number[] = [];
    let cur = 0;
    for (let i = 0; i < scriptObj.scenes.length; i++) {
      offsetStartTimes.push(cur);
      let p = 0;
      if (scriptObj.scenes[i].beat === 'hook') p = 0.6;
      if (scriptObj.scenes[i].beat === 'build' && i + 1 < scriptObj.scenes.length && scriptObj.scenes[i + 1].beat === 'payoff') p = 0.4;
      cur += scriptObj.scenes[i].duration_sec + p;
    }
    fs.unlinkSync(assPath);
    buildAssSubtitle(scriptObj.scenes, offsetStartTimes, assPath);
    tempFiles.push(assPath);

    console.log(`[story-video] Module E: compose ${fullScenes.length} scenes (incl intro+outro)...`);
    const filename = `video-story-s${seriesId}-ep${episodeNo}-v4-${Date.now()}.mp4`;
    const outputPath = path.join(MEDIA_DIR, filename);
    const bgmPath = selectBgmForVideo(scriptObj.scenes);
    const composeR = await composeMultiSceneVideo({
      scenes: fullScenes,
      sceneAudios: fullAudios, sceneVisuals: fullVisuals,
      bgmPath: fs.existsSync(bgmPath) ? bgmPath : undefined,
      assSubtitlePath: assPath,
      outputPath,
    });
    const fileSize = fs.statSync(outputPath).size;
    console.log(`[story-video] ✓ compose: ${(fileSize/1024/1024).toFixed(2)}MB, ${composeR.duration.toFixed(1)}s`);

    const videoUrl = `/media/${filename}`;
    const publicUrl = `${PUBLIC_BASE}${videoUrl}`;

    db.prepare(`UPDATE story_episodes SET video_url = ?, video_status = 'composed' WHERE id = ?`).run(videoUrl, ep.id);

    // ─── Module F: Reel caption ───
    console.log(`[story-video] Module F: gen Reel caption...`);
    const hookText = scriptObj.scenes[0].text;
    const reelCaption = await generateReelCaption(hookText, ep.caption, episodeNo);
    db.prepare(`UPDATE story_episodes SET reel_caption = ? WHERE id = ?`).run(reelCaption, ep.id);
    console.log(`[story-video] reel caption: ${reelCaption.length} chars`);

    if (opts.skipPublish) {
      // Cleanup temp
      for (const f of tempFiles) try { fs.unlinkSync(f); } catch {}
      return { ok: true, video_url: videoUrl, script: scriptObj, reel_caption: reelCaption, duration: composeR.duration };
    }

    // ─── Module 7: WHISPER VERIFY GATE (pre-publish safety) ───
    // Voice Ngan có limitation phát âm VN — nếu Whisper fail, KHÔNG publish
    console.log(`[story-video] Module 7: Whisper verify gate...`);
    try {
      const verifyR = spawnSync('python3', ['-c', `
from faster_whisper import WhisperModel
import sys
model = WhisperModel('tiny', device='cpu', compute_type='int8')
segments, info = model.transcribe(sys.argv[1], beam_size=1)
text = ' '.join(s.text.strip() for s in segments).lower()
print(f'LANG={info.language}|PROB={info.language_probability:.2f}|TEXT={text}')
`, outputPath], { encoding: 'utf8', timeout: 180_000 });
      const verifyOut = (verifyR.stdout || '') + (verifyR.stderr || '');
      const langMatch = verifyOut.match(/LANG=(\w+)/);
      const textMatch = verifyOut.match(/TEXT=(.+?)$/m);
      const detectedLang = langMatch?.[1] || '';
      const transcribedText = (textMatch?.[1] || '').toLowerCase();

      // ═══ PER-SCENE KEYWORD GATE (Option C) ═══
      // Voice Ngan STS có thể méo phát âm vài chỗ → check mỗi cảnh có ≥1 keyword hit là OK.
      // Pass nếu ≥60% scene có hit (vd 3/5 scene). Tốt hơn 30% match toàn bộ vì:
      //   - Filler words common ("mình", "không", "đã") match dễ
      //   - Per-scene đảm bảo voice cover hết toàn câu chuyện, không chỉ 1 phần
      const extractKeywords = (text: string, n = 6): string[] => {
        const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
        const words = cleaned.split(/\s+/).filter(w => w.length >= 3 && !/^\d+$/.test(w));
        return Array.from(new Set(words)).slice(0, n);
      };
      const sceneCheckResults = scriptObj.scenes.map((sc, i) => {
        const keywords = extractKeywords(sc.text, 6);
        const hits = keywords.filter(kw => transcribedText.includes(kw));
        return { idx: i + 1, beat: sc.beat, keywords, hits, ok: hits.length >= 1 };
      });
      const passCount = sceneCheckResults.filter(s => s.ok).length;
      const totalScenes = sceneCheckResults.length;
      const passRatio = totalScenes > 0 ? passCount / totalScenes : 0;

      console.log(`[story-video] Whisper per-scene: lang=${detectedLang}, ${passCount}/${totalScenes} scenes pass (${(passRatio*100).toFixed(0)}%, need ≥60%)`);
      for (const s of sceneCheckResults) {
        const tag = s.ok ? '✓' : '✗';
        console.log(`[story-video]   ${tag} scene ${s.idx} (${s.beat}): hits=[${s.hits.join(', ')}] of [${s.keywords.join(', ')}]`);
      }

      if (detectedLang !== 'vi' || passRatio < 0.6) {
        const errMsg = `voice_verify_fail: lang=${detectedLang}, scenes_passed=${passCount}/${totalScenes} (need vi + ≥60% scenes with ≥1 keyword)`;
        db.prepare(`UPDATE story_episodes SET video_status = 'verify_failed', error = ? WHERE id = ?`).run(errMsg, ep.id);
        for (const f of tempFiles) try { fs.unlinkSync(f); } catch {}
        console.warn(`[story-video] ⚠ ${errMsg} — SKIP PUBLISH`);
        return { ok: false, video_url: videoUrl, script: scriptObj, reel_caption: reelCaption, error: errMsg };
      }
    } catch (e: any) {
      console.warn(`[story-video] Whisper verify error (proceeding):`, e?.message);
    }

    // ═══ Multi-platform publish (FB + YouTube + IG sau) ═══
    // Per-platform error tolerance: 1 nền tảng fail KHÔNG block các nền tảng còn lại.
    const publishedTo: any = { facebook: [], youtube: null, instagram: null };

    // ─── A. Publish FB (multi-page loop) ───
    if (getSetting('enable_publish_facebook') !== '0') {  // default ON unless explicitly disabled
      console.log(`[story-video] publish FB...`);
      const pages = db.prepare(`SELECT id, fb_page_id, access_token, name, hotel_id FROM pages`).all() as any[];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        try {
          const r = await publishFbVideo(p.fb_page_id, p.access_token, publicUrl, reelCaption);
          publishedTo.facebook.push({ page_id: p.id, page_name: p.name, post_id: r.id, published_at: Date.now() });
          console.log(`[story-video] ✓ FB ${p.name}: video_id=${r.id}`);
        } catch (e: any) {
          const err = e?.response?.data?.error?.message || e?.message;
          console.warn(`[story-video] ✗ FB ${p.name}: ${err}`);
          publishedTo.facebook.push({ page_id: p.id, error: err });
        }
        if (i < pages.length - 1) await new Promise(r => setTimeout(r, 30_000));
      }
    }

    // ─── B. Publish YouTube Shorts ───
    if (getSetting('enable_publish_youtube') === '1') {
      console.log(`[story-video] publish YouTube Shorts...`);
      try {
        const { publishYoutubeShort } = await import('./youtube-publisher');
        const ytTitle = `Tập ${ep.episode_no}: ${ep.title || ep.beat || ''}`.slice(0, 95);
        const ytR = await publishYoutubeShort({
          videoPath: outputPath,
          title: ytTitle,
          description: reelCaption,
          tags: ['saigon', 'storytelling', 'vietnam', 'travel', 'sonder'],
          privacyStatus: 'public',
        });
        if (ytR.ok) {
          publishedTo.youtube = { video_id: ytR.video_id, url: ytR.url, published_at: Date.now() };
          console.log(`[story-video] ✓ YouTube: ${ytR.url}`);
        } else {
          publishedTo.youtube = { error: ytR.error };
          console.warn(`[story-video] ✗ YouTube: ${ytR.error}`);
        }
      } catch (e: any) {
        publishedTo.youtube = { error: e?.message };
        console.warn(`[story-video] ✗ YouTube import/fatal: ${e?.message}`);
      }
    }

    // ─── C. Publish Instagram Reel — TBD Step 2 (cần CDN public) ───
    // Placeholder: enable_publish_instagram check + module import sẽ thêm khi Step 2 ready
    if (getSetting('enable_publish_instagram') === '1') {
      console.log(`[story-video] IG Reel: chưa implement (Step 2 — cần CDN)`);
      publishedTo.instagram = { error: 'not_implemented_yet_step2' };
    }

    db.prepare(`UPDATE story_episodes SET video_published_to = ?, video_status = 'published' WHERE id = ?`)
      .run(JSON.stringify(publishedTo), ep.id);

    // Cleanup temp
    for (const f of tempFiles) try { fs.unlinkSync(f); } catch {}

    return { ok: true, video_url: videoUrl, script: scriptObj, reel_caption: reelCaption, published_to: publishedTo, duration: composeR.duration };
  } catch (e: any) {
    console.error('[story-video] FATAL:', e?.message);
    db.prepare(`UPDATE story_episodes SET video_status = 'failed' WHERE id = ?`).run(ep.id);
    for (const f of tempFiles) try { fs.unlinkSync(f); } catch {}
    return { ok: false, error: e?.message, script: scriptObj };
  }
}

export async function runDueStoryVideos(): Promise<{ found: number; published: number; failed: number }> {
  const now = Date.now();
  const due = db.prepare(
    `SELECT id, series_id, episode_no FROM story_episodes
     WHERE video_status IN ('pending', 'failed') AND video_scheduled_at IS NOT NULL
       AND video_scheduled_at <= ? AND video_scheduled_at > ?
     ORDER BY video_scheduled_at ASC LIMIT 1`
  ).all(now, now - 6 * 3600 * 1000) as any[];

  if (due.length === 0) return { found: 0, published: 0, failed: 0 };
  console.log(`[story-video] ${due.length} video(s) due`);
  let pub = 0, fl = 0;
  for (const item of due) {
    const r = await generateAndPublishVideo(item.series_id, item.episode_no);
    if (r.ok) pub++; else fl++;
  }
  return { found: due.length, published: pub, failed: fl };
}
