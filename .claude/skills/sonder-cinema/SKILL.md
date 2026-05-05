---
name: sonder-cinema
description: SKILL CỐT LÕI cho Sonder Cinema — module long-form 5-7 phút PREMIUM, 1 tập/tuần T7 20:30 VN. TÁCH BIỆT 100% với sonder-storytelling (Anthology Reels 1 phút). Use BẮT BUỘC khi build/edit/review video pipeline cinema, khi viết script long-form, khi user mention "Sonder Cinema", "phim ngắn Sonder", "cinema episode", "long form video Sonder", "5 phút", "documentary Sonder". Skill này lock philosophy cinema (multi-act vs 6-layer), tool stack (Veo + Hailuo + Seedance + Hedra), cost cap, character pool dùng chung Sonder universe nhưng KHÔNG dùng chung infrastructure với Anthology.
---

# Sonder Cinema — Marketing Bible (Long-Form Premium)

> **MỤC ĐÍCH**: Lock philosophy + structure + tool stack + cost cap cho Sonder Cinema. Module long-form TÁCH BIỆT 100% với Anthology Reels (sonder-storytelling skill). Cùng universe Sonder, cùng character pool, KHÁC infrastructure + format + tool stack.

## 🎯 3 DURATION MODES (tunable qua setting `cinema_target_duration_sec`)

| Mode | Duration | Shots | Cost/clip | Use case |
|------|----------|-------|-----------|----------|
| **PILOT** | 60-90s | 5-7 | $8-12 | **Test quality** — bắt đầu ở đây |
| **MID** | 180s (3 phút) | 10-14 | $25-35 | Proof concept long-form |
| **FULL** | 360s (5-7 phút) | 18-23 | $60-90 | Premium cinema (default goal) |

**Strategy**: Bắt đầu PILOT 60s. Nếu Veo/Hailuo output đẹp + audience engaged → upgrade MID → FULL.
PILOT MODE bỏ TITLE CARD và OUTRO, dùng 1 brand value duy nhất, closing line nằm trong Act III.

---

## 🌟 TRIẾT LÝ CINEMA (KHÁC vs Anthology Reels)

```
═══════════════════════════════════════════════════════════════════
  CINEMA = "Mỗi tập là 1 chương sách. Reel là 1 trang."
═══════════════════════════════════════════════════════════════════

  1. LONG-FORM ARC — 5-7 phút trọn vẹn 1 chương sâu của character
  2. MULTI-ACT STRUCTURE — 3 acts (setup/conflict/reflect), không 6-layer
  3. CINEMATIC PRODUCTION — pro tools (Veo/Hailuo/Hedra), $80/tập
  4. AUDIENCE: viewer cố ý click — không scroll feed. Quality first.
  5. VẪN GIỮ: Ý tự thành, no quảng cáo, brand values qua hành động.
═══════════════════════════════════════════════════════════════════
```

### Khác biệt Cinema vs Anthology

| Yếu tố | Anthology Reels | Cinema |
|--------|----------------|--------|
| Duration | 60-90s | 300-420s (5-7 phút) |
| Frequency | 1 tập/ngày 19:00 | 1 tập/tuần T7 20:30 |
| Structure | 6 layers fixed | 3 acts (15-25 shots) |
| Production | AI image + Pexels stock | Veo + Hailuo + Hedra (real video) |
| Cost/tập | ~$1 | ~$80 |
| Platform | FB Reels + YT Shorts | YT long-form (primary) + FB Reels 60s teaser |
| Audience intent | Scroll/discover | Click/watch |
| Goal | Brand presence daily | Deep engagement weekly |
| DB tables | story_*, story_continuity | cinema_* (RIÊNG) |

---

## 🎬 3-ACT STRUCTURE (LOCKED — không phải 6-layer)

```
┌──────────────────────────────────────────────────────────────────┐
│ TỔNG: 6 phút trung bình = 360s | 18-23 shots | 600-900 từ VN    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ COLD OPEN (15s)                                                  │
│   1 hero shot KHÔNG voiceover. Visual hook duy nhất.            │
│   Audience phải tự hỏi "đây là ai? đang gì?"                    │
│   ✅ Linh ngồi cửa sổ máy bay nhìn Sài Gòn ban đêm hiện ra      │
│   ❌ Title card "Sonder presents..."                             │
│                                                                  │
│ TITLE CARD (5-10s)                                               │
│   Format: "Sonder Cinema #N" trên fade black                     │
│   Tên tập + tên character chính                                  │
│   1 voiceover line giới thiệu nhẹ (8-12 từ)                     │
│                                                                  │
│ ACT I — SETUP (90s, 5-6 shots)                                  │
│   Establish character + context + stake.                         │
│   Đưa audience vào thế giới, gặp nhân vật.                       │
│   Voiceover POV "mình" intimate.                                 │
│   ⚠ KHÔNG mention "Sonder", KHÔNG hard CTA.                     │
│                                                                  │
│ ACT II — STORY/CONFLICT (180s, 8-10 shots) ★★★ TRỌNG TÂM ★★★    │
│   Friction → Encounter → Realization                             │
│   Brand values 1-2 thấm qua HÀNH ĐỘNG (Tuấn pha trà, Vy nhớ ai) │
│   Logo placements visual subtle (3-5 lần qua episode)            │
│   Có thể có dialogue close-up (Hedra lip-sync)                   │
│                                                                  │
│ ACT III — REFLECTION (90s, 4-5 shots) ★ Ý TỰ THÀNH ★             │
│   Inner monologue, payoff arc                                    │
│   POETIC closing line, fade to logo                              │
│   Brand value transcends qua suy nghĩ                            │
│   ⚠ KHÔNG kết luận thẳng "Sonder là...", KHÔNG CTA               │
│                                                                  │
│ OUTRO (15s)                                                      │
│   1 shot atmospheric + Sonder logo fade in slowly                │
│   Silent music outro                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🎨 SHOT TYPE → TOOL ROUTING (LOCKED)

Mỗi shot có 1 trong 4 types — auto-route đến tool tốt nhất:

```
┌─────────────────────────────────────────────────────────────────┐
│ SHOT TYPE         │ TOOL              │ Use case               │
├─────────────────────────────────────────────────────────────────┤
│ HERO_ESTABLISHING │ Veo 3.1 Premium   │ Wide cinematic +       │
│                   │ ($0.40/s w/audio) │ ambient sound          │
│                   │                   │ "Sài Gòn 5h sáng       │
│                   │                   │  từ trên cao golden"   │
│                   │                   │ → 6-12s mỗi shot       │
├─────────────────────────────────────────────────────────────────┤
│ CHARACTER_SCENE   │ Hailuo 2.3 Pro    │ Linh đi bộ, Tuấn pha   │
│                   │ ($0.49/video)     │ trà, micro-expression  │
│                   │                   │ best face consistency  │
│                   │                   │ → 6-10s mỗi shot       │
├─────────────────────────────────────────────────────────────────┤
│ ATMOSPHERIC_BROLL │ Seedance 2.0 Fast │ Texture cảnh quay:     │
│                   │ ($0.022/s)        │ ly trà nóng, ánh đèn,  │
│                   │                   │ ga giường, tay viết    │
│                   │                   │ → 4-8s, RẺ             │
├─────────────────────────────────────────────────────────────────┤
│ TALKING_HEAD      │ Hedra Character-3 │ Tuấn POV monologue,    │
│                   │ ($16/mo + $0.05/m)│ Linh viết nhật ký dial │
│                   │                   │ photoreal lip-sync     │
│                   │                   │ → 8-15s mỗi shot       │
└─────────────────────────────────────────────────────────────────┘
```

**Storyboard rule**: Per episode 18-23 shots, mix:
- Hero: 4-5 shots (25%)
- Character: 6-8 shots (35%)
- B-roll: 5-6 shots (25%)
- Talking head: 2-3 shots (10%)
- Outro: 1 shot

---

## 🔥 VIRAL HOOK PATTERNS (research 2026 — adapted cho long-form)

Cinema hook khác Anthology: cold open KHÔNG có voiceover, chỉ visual. Trong
3 giây đầu PHẢI grab attention. Pick 1 trong 3 patterns sau:

### Pattern A — TEXTURAL VISUAL HOOK ⭐ default cho Cinema
```
First 3-6 seconds: Macro/extreme close-up texture, NO voiceover.
Examples:
  ✅ Hơi nóng bay lên từ ly trà gừng (extreme close)
  ✅ Tay viết chữ vào nhật ký, mực chảy nhẹ
  ✅ Hạt mưa lăn dài trên cửa kính
  ✅ Chìa khoá xoay trong ổ khoá đồng cũ
Why: Silent vlog 2026 trend — 50%+ users xem mute
```

### Pattern B — OBJECT-AS-CHARACTER HOOK
```
First 3s: Close-up 1 vật + reveal chủ nhân muộn hơn (Act I shot 2)
Examples:
  ✅ Cuốn nhật ký mở (3s) → Linh cầm bút (Act I)
  ✅ Tag "Tuấn + Sonder logo" (3s) → mặt Tuấn (Act I)
  ✅ Chìa khoá đồng (3s) → Linh nhận ở quầy
Why: Aesthetic hook + curiosity. Logo SUBTLE qua object.
```

### Pattern C — TIME ANCHOR + WIDE ESTABLISHING
```
First 3-6s: Wide cinematic shot + 1 line VO ngắn 5-8 từ
Examples:
  ✅ "Đêm thứ 3 tại Sài Gòn." + drone shot Sonder Bình Thạnh
  ✅ "5 giờ sáng. Mưa lớn." + alley wide shot
Why: Brain anchor cụ thể, set scene fast
```

## ⏱ RETENTION ENGINEERING — Cinema 6 phút (PILOT 60s khác)

```
Cinema FULL 6 phút:
  Mỗi 30 giây phải có 1 mini-hook (re-grab attention)
  - 0:00-0:15  Cold open (Pattern A/B/C)
  - 0:15-0:25  Title card (5-10s)
  - 0:25-1:55  Act I (90s) — 2 mini-hooks tại 0:50, 1:25
  - 1:55-4:55  Act II (180s) — 4 mini-hooks every 45s
  - 4:55-6:25  Act III (90s) — payoff cumulative
  - 6:25-6:40  Outro (LOOP REWARD: visual echo cold open)

Cinema PILOT 60s:
  - 0:00-0:06  Cold open (Pattern A texture)
  - 0:06-0:24  Act I (18s)
  - 0:24-0:48  Act II core moment (24s)
  - 0:48-0:60  Act III + LOOP REWARD (12s)
```

**LOOP REWARD field**: Mỗi episode PHẢI có shot cuối ECHO visual cold open
(ly trà cạn nửa → cạn hết, mưa hạt → mưa nhỏ giọt). Composer apply matching
fade style + sound bridge.

## 🚫 KHÔNG được làm (giữ ý tự thành — same as Anthology)

```
❌ Aggressive curiosity gap "5 sai lầm..."
❌ Hard CTA "Subscribe để xem tập sau"
❌ Sensational "They don't want you to know..."
❌ High-energy delivery (Cinema = SLOW intentional)
❌ Numbered list narration
❌ POV "các bạn" thay "mình"

VIRAL ≠ SENSATIONAL. Cinema VẪN là LITERATURE/POETRY.
Patterns chỉ ARRANGE cold open + transitions + loop, KHÔNG đổi VOICE.
```

---

## 💎 BRAND VALUES (cùng pool với Anthology — share philosophy)

Cinema thấm 1-2 values per episode (giống Anthology), nhưng DEEPER vì có 5+ phút để show:

- `respect_individual` — Cinema có thể xây 1 cả Act II quanh "Tuấn không hỏi"
- `warm_like_home` — Cinema có thể show 5 chi tiết warm trong 1 episode
- `understand_local` — Cinema có thể follow Linh đi quán phở thật, ngồi 3 phút
- `always_someone_waits` — Cinema có thể xây arc "10h khuya khách đến muộn"

Cinema KHÔNG phải Anthology x6. Cinema = **deep dive 1 moment thay vì lướt 6 moments**.

---

## 👥 CHARACTER POOL (DÙNG CHUNG vs Anthology)

Đọc từ table `story_characters` (cùng table với Anthology). 6 nhân vật:
- Linh, Tuấn, Vy, Khanh, Hà, Tài

Cinema RESPECT continuity từ `story_continuity` table (Anthology established facts).
Ví dụ: Tập Cinema "Một Đêm Ở Sonder" PHẢI biết Linh đã ăn Phở Bà Tám (ep#13 Anthology fact).

→ Cinema **đọc** continuity, **không ghi vào** continuity (tránh contamination).

---

## 📅 LỊCH (LOCKED)

```
═══════════════════════════════════════════════════════════════
  T7 (Saturday) 20:30 VN  —  1 tập Cinema mỗi tuần
═══════════════════════════════════════════════════════════════

  Logic delay so với Anthology:
    19:00 — Anthology Reel T7 Crossover (1 phút)
    20:30 — Cinema Long-Form (5-7 phút)
    
  Audience flow: xem Reel ngắn → thích → click YouTube xem Cinema
                  → ritual T7 tối là Sonder time deep
                  
  4 tuần = 4 tập/tháng. Mỗi tập ~$80. Total ~$330/tháng.
═══════════════════════════════════════════════════════════════
```

---

## 💰 COST GOVERNANCE (BẮT BUỘC)

```
Per-episode budget: $80 default (settable cinema_max_cost_per_episode_usd)
Monthly cap:       $400 default (settable cinema_max_monthly_budget_usd)

Pre-flight check (BẮT BUỘC trước khi gen):
  1. Load storyboard với shot list
  2. Estimate cost qua provider pricing
  3. If estimate > per-episode cap → ABORT + log
  4. Check monthly cumulative cost
  5. If month + estimate > monthly cap → ABORT + alert admin

Per-shot logging: cinema_costs_log table tracks every API call:
  episode_id, shot_id, provider, duration_sec, cost_cents, timestamp

Failure recovery:
  - Veo quota hit → auto fallback Kling 3.0 Standard ($0.10/s)
  - Hailuo limit → fallback Hailuo Standard $9.99/mo plan
  - Hedra quota → fallback static image with subtitle
```

---

## 🎙 VOICE (CHIA SẺ với Anthology)

→ Vẫn dùng skill `sonder-brand-voice` — Edge-TTS HoaiMy → ElevenLabs STS Ngân.

**Khác biệt Cinema:**
- Long-form: chia voiceover thành 5-8 segments (per shot hoặc per beat)
- Talking head shots: voice từ Hedra (lip-sync), KHÔNG dùng Ngân voice
- Narrator (POV "mình") shots: dùng Ngân voice qua sonder-voice utility

**Multi-character voices** (tương lai cần clone thêm):
- Tuấn talking head: voice male elder warm
- Vy talking head: voice female warm 30s
- Khanh talking head: voice Korean accent VN

---

## ✅ QUALITY CHECKLIST trước khi publish

Mỗi tập Cinema PHẢI pass (15 items):

- [ ] 3-act structure đầy đủ (cold open + 3 acts + outro)
- [ ] Total 5-7 phút (300-420s)
- [ ] 18-23 shots
- [ ] Cost trong budget cap ($80 default)
- [ ] 1-2 brand values thấm qua hành động
- [ ] Logo Sonder visual 3-5 lần (subtle)
- [ ] KHÔNG mention "Sonder", "khách sạn", "đặt phòng" trong narration
- [ ] Tên VN thật từ character pool
- [ ] Continuity respect từ Anthology eps gần đây
- [ ] Voiceover Ngân (narrator) + Hedra (talking head) không lẫn
- [ ] Cinematic grade applied (curves + film grain + vignette)
- [ ] Watermark Sonder constant (alpha 0.32)
- [ ] BGM mood phù hợp arc
- [ ] Closing line poetic, fade logo
- [ ] Whisper verify gate pass (lang=vi)

❌ Tập KHÔNG pass nếu:
- Có CTA "Inbox", "Đặt phòng", "Gọi ngay"
- Có "Sonder cam kết", "Sonder tự hào"
- Có character không trong pool
- Cost vượt cap không được approve manual
- Duration < 4 phút hoặc > 8 phút

---

## 🏗 ARCHITECTURE (TÁCH 100%)

```
src/services/cinema/                  ← MODULE RIÊNG
  cinema-engine.ts                    schedule + shot type rules
  cinema-script-writer.ts             Claude → 18-23 shot script
  cinema-storyboard.ts                script → shot list + tool routing
  cinema-providers/
    veo-client.ts                     FAL → Veo 3.1
    hailuo-client.ts                  FAL → Hailuo 2.3 Pro
    seedance-client.ts                FAL → Seedance 2.0 Fast
    hedra-client.ts                   Hedra Character-3
  cinema-voice.ts                     ElevenLabs longform v2
  cinema-composer.ts                  FFmpeg stitch 18-23 shots
  cinema-cost-tracker.ts              budget cap + per-shot log
  cinema-orchestrator.ts              full pipeline
  cinema-publisher.ts                 YT primary + FB Reels 60s teaser

src/db.ts thêm tables RIÊNG:
  cinema_series                       cinema-level concept
  cinema_episodes                     1 row mỗi tập
  cinema_shots                        1 row mỗi shot trong tập
  cinema_costs_log                    detailed cost tracking

src/routes/cinema.ts                  admin API riêng
src/public (cinema tab)               admin UI riêng

KHÔNG IMPORT từ anthology/*
KHÔNG ghi vào story_episodes / story_continuity
SHARE 1 thứ: src/services/sonder-voice.ts (brand voice)
```

---

## 📚 5 IDEAS TẬP ĐẦU (đã approved)

### Tập 1: "Một Đêm Ở Sonder" (Linh, 6 phút)
- Continuity: callback ep#13 Anthology "Phở Đầu Tiên"
- Cold open: Linh ngồi sảnh đêm, đèn vàng, viết nhật ký
- Act I (90s): Linh ngày 2 ở SG, vẫn lạ, ngồi sảnh, Tuấn rót trà
- Act II (180s): cuộc nói chuyện ngắn với Tuấn, callback "Phở Bà Tám" — Tuấn hỏi "Cô ăn phở rồi à?", Linh kể, Tuấn cười
- Act III (90s): Linh về phòng, viết nhật ký "Sài Gòn không vội. Mình cũng không cần vội"
- Brand values: warm_like_home + understand_local
- Logo: tag Tuấn, tea cup, brass key, guest book Linh viết

### Tập 2: "Tuấn — 30 Năm Trong Nghề" (mini-doc 7 phút)
- POV chú Tuấn talking head heavy (Hedra Character-3 60% footage)
- Veo flashback Sài Gòn 1996 thời Tuấn mới làm khách sạn 5 sao
- Brand values: respect_individual ("khách sáo quá" → bỏ đến Sonder)

### Tập 3: "Cafe Vy Mở 6 Năm" (Vy POV 6 phút)
- Vy talking head + b-roll cafe (Seedance cheap)
- Story chia tay chồng → mở cafe → khách Sonder ghé đều
- Brand values: warm_like_home

### Tập 4: "Khanh — Người Hàn Quay Lại Lần 5" (cross-culture 5 phút)
- Khanh accent VN nhẹ talking head
- Brand values: respect_individual + always_someone_waits

### Tập 5: "Hà — Mama Vào Sài Gòn" (mother-daughter 6 phút emotional)
- Hailuo emotional micro-expression heavy
- Veo cảnh sân bay Đà Nẵng → Sài Gòn xe buýt
- Brand values: tất cả 4 values thấm qua

---

## 🚦 SAFETY RAILS

1. **Test mode trước khi cron live**: 5 tập đầu phải manual generate qua admin UI, review Whisper gate, mới enable cron T7 auto.
2. **Whisper verify**: ASR audio match script keywords ≥85% (catch lip-sync drift).
3. **Face consistency check**: Hailuo close-up Linh phải match reference image LoRA (similarity ≥0.75).
4. **Cost log mỗi shot**: nếu shot fail → KHÔNG retry quá 2 lần (tránh burn budget).
5. **Manual override**: admin có thể dừng cron Cinema bất cứ lúc nào qua setting `cinema_cron_enabled='false'`.

---

## ⚠️ KHÁC SOnder-storytelling NHƯ THẾ NÀO

| Skill rule | Anthology | Cinema |
|-----------|-----------|--------|
| Hook | 8-12 từ surface + 8-12 từ arc | Cold open VISUAL (no VO) |
| Layers | 6 fixed | 3 acts flexible |
| Visual | AI image static + Pexels | Real video gen (Veo/Hailuo/Seedance) |
| Voice | Per-layer 6 segments | Per-shot 8-15 segments + talking head Hedra |
| Compose | FFmpeg 6-segment stitch | FFmpeg 18-23 segment stitch with cross-fade |
| Continuity | Read + Write | Read only (respect, không pollute) |

---

## 🎯 KPI THÀNH CÔNG

- YT retention: ≥45% (long-form benchmark good)
- YT subscribers gained per episode: ≥30
- FB teaser CTR to YT: ≥5%
- Cost actual ≤ budget cap 90% of months
- Whisper verify pass rate ≥85%
- Audience comment quality: 1+ "tôi cảm được" type per episode

---

📎 Reference skill (cùng universe):
- `sonder-storytelling` — Anthology Reels (1 phút daily)
- `sonder-brand-voice` — Edge-TTS → STS Ngân (chia sẻ utility)
- `sonder-ecosystem` — overall brand context

Cinema là layer thứ 2 của Sonder content stack. Anthology là **breath** (daily). Cinema là **chapter** (weekly).
