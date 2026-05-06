---
name: sonder-content-v5
description: BẮT BUỘC đọc khi user yêu cầu build/edit/review pipeline content tự động (FB Reels, IG Reels, TikTok, YouTube Shorts) cho Sonder. Skill lock V5 principles SAU pivot từ V3 Anthology FLOP — Hybrid 60% real footage + 30% AI assist + 10% pure AI. Cấm 100% AI gen (bị Meta C2PA detect → reach -80%). Lock 2 themes (Sài Gòn Insider + Sonder BTS), A/B test 3 variants, retention >70%, kill rule sau 60 ngày. Use khi user mention "đăng bài tự động", "content viral", "Reels", "TikTok Sonder", "tăng followers", "post bài hay hơn", hoặc bất cứ quyết định nào về content strategy production.
---

# Sonder Content V5 — Reborn Strategy Bible

> **MỤC ĐÍCH**: Lock 100% nguyên tắc V5 sau diagnose V3 Anthology FLOP (reach 0-3 views/clip, $300/mo wasted).

> **CONTEXT**: 2026-05-06 user phê duyệt rebuild content pipeline. V3 Anthology paused. V5 launch theo plan đã đối chiếu 10 nguồn research.

---

## 🎯 NGUYÊN TẮC BẤT BIẾN

```
═══════════════════════════════════════════════════════════════════
  "AI ASSISTS, HUMAN OWNS"
═══════════════════════════════════════════════════════════════════

  1. HYBRID 60/30/10 — KHÔNG 100% AI gen
     • 60% REAL footage Sonder (chú Tuấn / lễ tân quay phone)
     • 30% AI-assisted (real base + AI overlay)
     • 10% pure AI (chỉ Cinema reuse)

  2. EDITORIAL OWNERSHIP — claim Article 50(4) exemption
     • Anh duyệt mọi post Phase 1-3
     • Auto-publish chỉ khi confidence > 80% Phase 4+
     • Mỗi post → human review checkpoint → claim "human responsibility"
     → Exempt khỏi Meta C2PA AI label penalty (-15-80% reach)

  3. RETENTION DRIVES LENGTH (KHÔNG fixed length)
     • 20s @ 85% retention > 60s @ 40% retention
     • Default 15-30s, có thể 60-90s nếu retention chứng minh
     • Pacing 2-3s/cut tối thiểu

  4. 2 THEMES ONLY (algorithm tag stability)
     • Theme 1 (60%): SÀI GÒN INSIDER GUIDE
     • Theme 2 (40%): SONDER BEHIND-THE-SCENE
     → Algo scan 9-12 posts gần nhất → tag = "Saigon local + boutique"

  5. A/B TEST EVERY POST (3 variants minimum)
     • Variant A: hook pattern 1
     • Variant B: hook pattern 2
     • Variant C: hook pattern 3
     • Same body, different first 3s
     → GrowthBook track winners → reuse pattern

  6. KILL RULE 60 DAYS
     • 2+ Tier 1 metrics fail → STOP automation
     • KHÔNG đốt tiền vô ích như V3

═══════════════════════════════════════════════════════════════════
```

---

## ❌ ANTI-PATTERNS — KHÔNG được làm

| ❌ KHÔNG | Lý do | ✅ THAY BẰNG |
|---|---|---|
| 100% AI gen content | Meta C2PA flag → reach -80% | Hybrid 60% real footage |
| Auto-publish ngay không review | Vi phạm Article 50(4) exemption | Anh duyệt Phase 1-3 |
| Length fixed 60-90s | V3 flop với pattern này | Retention drive (15-90s) |
| Hook 0-3s = text VO | Algo: silent visual win | Textural close-up macro |
| 1 variant/post | Không learn được gì | 3 hook variants A/B/C |
| Pacing 1 cut/13s (V3) | Podcast feel, audience skip | 2-3s/cut min |
| Spread 5+ themes scattered | Algo không tag được | 2 themes only stable |
| Hard-sell ad copy | Bóp page edge rank | Insider guide + BTS |
| Engagement bait "Like share" | Meta penalty | Trigger spontaneous comments |
| Boost organic post | Burn budget | Conversion campaign Meta Ads |
| Cross-post Nhà Tốt 247 | Spam signal đã chứng minh | DISABLED forever |
| Re-enable Anthology daily | FLOP pattern, kill rule | KHÔNG cho đến khi pass V5 metrics |

---

## ✅ STACK V5 LOCKED

### Generation Layer
| Tool | License | Use | Cost |
|---|---|---|---|
| **Qwen2.5-7B Ollama** (existing) | Apache | Script + idea Vietnamese | $0 |
| **Claude 3.5 Sonnet** | API | Script complex moments | $5/mo |
| **FAL Flux** | API | Image gen $0.025/img | $5/mo |
| **FAL Wan 2.2** | API | Video gen $0.10/clip | $10/mo |
| **Edge-TTS HoaiMy** (existing) | Microsoft | Draft TTS | $0 |
| **ElevenLabs STS Ngân** (existing) | Cloud | Voice clone | $5/mo |
| **FFmpeg** (existing) | LGPL | Compose | $0 |

### A/B Testing Layer
| Tool | License | Use |
|---|---|---|
| **GrowthBook** | MIT | A/B test 3 variants → winner |
| **PostHog** (existing) | MIT | Funnel + retention analytics |

### Cross-platform Publishing
- FB Reels (Graph API existing)
- IG Reels (Graph API via FB Page link)
- TikTok (TikTok API for Business — register Phase 4)
- YouTube Shorts (existing OAuth, fix scope)

### Real Footage Repository
- Path: `/var/sonder-real-footage/` on VPS
- Admin UI: `app.sondervn.com/admin/footage`
- Upload via batch (drag-drop hoặc Telegram bot)
- Tags: location (Airport/Q1/BinhThanh/PhuNhuan), character (Tuan/Linh/etc), moment

---

## 📐 6-LAYER STRUCTURE V5 (cập nhật từ V3)

```
LAYER 1: HOOK (0-3s) — silent visual + textural
  Pattern A/B/C variants tested
  Examples:
    A: Macro close-up hơi nóng trà gừng (3s ASMR)
    B: Tay viết nhật ký (3s POV)
    C: Chìa khoá xoay ổ khoá đồng (3s textural)
  → A/B/C tested — winner reused next post

LAYER 2: CONTEXT (3-8s) — establish where + when
  REAL footage primary (sảnh, view, character)
  POV "mình" intimate VO bắt đầu
  Sensory grounding 1-2 chi tiết

LAYER 3: ENCOUNTER (8-20s) ★ BRAND ACTION ★
  REAL footage chú Tuấn / lễ tân (60% pillar)
  Hành động cụ thể: pha trà, mở cửa, đẩy tờ giấy
  Brand value via behavior, KHÔNG declaration

LAYER 4: SENSORY DETAIL (20-25s)
  Macro AI-assist OK (close-up textural)
  5 giác quan ground reality

LAYER 5: REFLECTION (25-28s) — Ý TỰ THÀNH
  Inner monologue 1 câu
  POETIC, không CTA

LAYER 6: LOOP REWARD (28-30s) ⭐ VIRAL CRITICAL
  Visual ECHO opening shot
  Sound bridge match
  Logo Sonder fade in slowly
```

**Total target**: 15-30s default. 60-90s OK nếu retention pilot >70%.

---

## 🔥 7 VIRAL HOOK PATTERNS V5 (rotate daily)

### Pattern 1: TEXTURAL ASMR (no VO 0-3s) ⭐ silent default
```
First 3s: Macro close-up texture, ZERO voiceover
Examples:
  ✅ Hơi nóng bay từ ly trà gừng (3s macro)
  ✅ Tay viết nhật ký (3s)
  ✅ Hạt mưa lăn dài cửa kính (3s)
  ✅ Chìa khoá xoay trong ổ khoá đồng (3s)
Why: 50%+ users xem mute → silent visual = strongest hook
```

### Pattern 2: TIME + LOCATION SPECIFIC ⭐
```
Format: <giờ chính xác> + <địa điểm chính xác>
Examples:
  ✅ "5h45 sáng. Hẻm Bình Thạnh."
  ✅ "11h đêm. Sảnh Sonder Airport."
  ✅ "14h30 chiều. Cafe Vy đối diện Sonder Q1."
Why: Brain anchor cụ thể → cảm giác thật
```

### Pattern 3: OBSERVATIONAL MICRO-DETAIL
```
Format: 1 chi tiết bình thường người khác bỏ qua
Examples:
  ✅ "Chú Tuấn không hỏi mình từ đâu đến."
  ✅ "Ly trà đặt sẵn trên bàn. Không ai nói gì."
Why: Curiosity gap NHẸ — không sensational
```

### Pattern 4: EXPECTATION vs REALITY
```
Format: <Expectation>. Nhưng <reality>.
Examples:
  ✅ "Tưởng đêm SG ồn. Hoá ra phòng này yên hơn nhà cũ."
  ✅ "Định không nói chuyện với ai. Chú Tuấn đẩy ly trà."
Why: Cognitive dissonance hook
```

### Pattern 5: NUMERICAL SERIAL ⭐ binge-worthy
```
Format: "Ngày/Tuần/Lần thứ N tại Sonder. <hành động>."
Examples:
  ✅ "Đêm thứ 3 tại Sài Gòn. Mình chưa gọi điện về nhà."
  ✅ "Lần thứ 4 anh Khanh quay lại Sonder Airport."
Why: Serial format → binge → algorithm boost
```

### Pattern 6: OBJECT-AS-CHARACTER ⭐ Sonder logo bonus
```
Format: First 3s = close-up 1 vật → reveal owner late
Examples:
  ✅ Macro chìa khoá đồng (3s) → cut Linh cầm chìa
  ✅ Cuốn nhật ký mở (3s) → cut tay Linh cầm bút
Why: Aesthetic-first feed + curiosity. Logo SUBTLE qua object.
```

### Pattern 7: GUEST POV (REAL — Khanh, Linh nano-influencer)
```
Format: Real guest selfie/POV phone shot
Examples:
  ✅ Anh Khanh ngồi sảnh, voiceover Hàn accent VN
  ✅ Cô Hà mẹ Linh đến thăm, real footage
Why: AUTHENTIC — exempt 100% AI label, real face = trust 2.4×
```

---

## 📊 SUCCESS METRICS (LOCK)

### Tier 1 — MUST HIT (60d kill rule)

| Metric | Target | Source |
|---|---|---|
| Completion rate halfway | **>50%** | Algo 2026 4× boost |
| First hour engagement | **>50 reactions** | 80% viral potential |
| Private DM shares | **>3/post** | Strongest signal |
| Cost per 1000 views | **<$1** | Industry benchmark |

### Tier 2 — SHOULD HIT
| Metric | Target |
|---|---|
| Monthly followers gained | +500 organic |
| Save rate | >2% |
| Cross-platform consistency | 100% (FB+IG+TikTok+YT) |
| Cost per booking attribution | <$15 |

### Tier 3 — NICE TO HAVE
- Brand mentions in comments >10/mo
- Direct booking ratio >30%
- Repeat viewer rate >25%

### KILL RULE
- 60d sau launch
- 2+ Tier 1 fail → STOP, refund lessons
- 1 Tier 1 + 2 Tier 2 fail → reduce frequency 50%
- All Tier 1 pass → green light scale Phase 4+

---

## 🚦 DECISION RULES — Phiên Claude tương lai

| Khi user đề xuất | Phản hồi đúng |
|---|---|
| "Đăng 100% AI clip" | REJECT — Meta C2PA penalty. Hybrid 60% real |
| "Auto-publish luôn" | REJECT Phase 1-3. Allow Phase 4+ nếu confidence > 80% |
| "Boost post organic 5tr" | REJECT — burn budget. Use Meta Ads conversion |
| "Re-enable V3 Anthology" | REJECT until V5 hit all Tier 1 metrics |
| "Tăng 5 themes" | REJECT — algorithm needs 2 themes only |
| "Hook = text VO 0-3s" | REJECT — silent visual ASMR win |
| "Engagement bait 'Like share'" | REJECT — Meta penalty |
| "Length 90s consistently" | REJECT — retention drive, not length |
| "Skip A/B test 1 post nhanh" | REJECT — 3 variants minimum always |
| "Cross-post Nhà Tốt 247" | REJECT — spam signal proven |

---

## 📋 PHASE GATES (KHÔNG proceed nếu fail)

### Gate 0 (pre-flight)
- ✅ Real footage initial batch (≥20 clips từ Sonder staff)
- ✅ 5 decisions confirmed (themes, volume, hardware, ads, auto-publish)

### Gate 1 (Week 2)
- ✅ 1 hybrid clip render successful + admin approval

### Gate 2 (Week 4)
- ✅ Sau 14 clips: ≥2 clips pass all Tier 1 metrics
- ❌ 0 clips pass → STOP, debug + pivot

### Gate 3 (Week 6)
- ✅ ≥5 clips total achieve all 3 Tier 1 metrics simultaneously
- ❌ Fail → KILL automation, refund lessons doc

### Gate 4 (Week 8)
- ✅ Cost per booking <$20 attribution proven
- ✅ Auto-publish enabled cho variants giống winner

### Gate 5 (Week 12)
- ✅ Monthly ROI report positive
- ❌ Fail → reduce volume 50% hoặc sunset

---

## 🛡 RISK MITIGATION

| Risk | Mitigation |
|---|---|
| Real footage không đủ | Anh quay 20-30 clips trước Week 1. Backup: nano-influencer outreach |
| Meta C2PA AI penalty | Hybrid 60% real + admin review checkbox claim editorial |
| FAL cost overrun | Cap monthly $30 + Telegram alert |
| Quality regression | Anh duyệt mọi post Phase 1-2 |
| Burnout admin review | Auto-publish confidence > 80% Phase 4+ |
| Algorithm change | Monthly Meta blog check + adjust pipeline |
| GPU VPS downtime | Option A FAL backup |

---

## 📚 LINKED SKILLS

- `sonder-tech-sovereignty` — OSS stack lock + budget cap
- `sonder-storytelling` — Philosophy + 6-layer structure (V5 inherits)
- `sonder-cinema` — V4 Cinema weekly (giữ active)
- `sonder-brand-voice` — TTS pattern (V5 dùng)
- `sonder-sso-identity` — Authelia gate cho admin UI

---

## 🚨 CRITICAL REMINDERS cho Claude tương lai

1. **KHI USER nói "AI clip viral"** → propose Hybrid 60% real, KHÔNG 100% AI
2. **KHI USER muốn skip review post** → enforce admin duyệt Phase 1-3
3. **KHI USER quên 2 themes** → reject 5+ themes scattered
4. **KHI METRICS fail Tier 1** → enforce kill rule, KHÔNG đắp tiền hi vọng
5. **KHI USER MUỐN re-enable V3** → reject cho đến khi V5 prove metrics
6. **KHI deploy mới tool** → check skill này first, integrate respect

---

**LAST UPDATED**: 2026-05-06
**OWNER**: Sonder Content Strategy
**TRIGGER COUNT**: ALL content automation decisions
**REVIEW CYCLE**: Mỗi 60 ngày — verify metrics, adjust hooks, evolve pillars
