# 🎬 V5 CONTENT PLAN + CONTINUATION HANDOFF

> **Created**: 2026-05-06 (phiên Sonder)
> **Purpose**: Document plan V5 + checklist resume từ máy khác
> **Skill reference**: `.claude/skills/sonder-content-v5/SKILL.md`

---

## ⚡ TLDR — 30 GIÂY ĐỂ HIỂU

```
V3 Anthology FLOP (reach 0-3 views) → PIVOT V5
  ├─ Hybrid 60% real footage + 30% AI assist + 10% pure AI
  ├─ Anh duyệt mỗi post → claim Article 50(4) editorial → exempt AI penalty
  ├─ 2 themes: Sài Gòn Insider (60%) + Sonder BTS (40%)
  ├─ Length retention drive (15-90s, NOT fixed)
  ├─ A/B test 3 hook variants every post
  ├─ Cross-post FB+IG+TikTok+YT
  └─ Kill rule 60d: 2+ Tier 1 metrics fail → STOP
```

---

## 📋 PRE-FLIGHT (anh phải làm trước Phase 1)

### CRITICAL — em không proceed nếu thiếu

#### 1. Real footage initial batch (60% pillar)
Anh ask chú Tuấn / lễ tân quay **20-30 clips điện thoại**:
- Format: vertical 9:16, không cần edit, raw OK
- Length mỗi clip: 5-15 giây
- Themes:
  - Pha trà gừng (sảnh đêm)
  - Sảnh ngày mưa
  - View phòng buổi sáng
  - Khách check-in muộn
  - Dọn phòng chỉn chu
  - Hành lang đèn vàng
  - Bếp chung pha cà phê
  - Cây nhãn sân trong (Bình Thạnh)
  - Bitexco view từ Q1
  - Chìa khoá đồng (close-up)
  - Sổ guest book (close-up)

→ Upload qua admin UI sẽ build (Phase 1) HOẶC tạm Telegram bot.

**Time investment**: lễ tân ~1-2h tổng.

#### 2. 5 quyết định strategy

| # | Câu hỏi | Em recommend |
|---|---|---|
| 1 | 2 themes content | "Sài Gòn Insider" + "Sonder BTS" |
| 2 | Volume posts/tuần | **5 posts/tuần** (T2-T6, nghỉ T7-CN) |
| 3 | Hardware | **Option A: FAL ~$20/mo** trước 60d |
| 4 | Meta Ads | Đợi **30d organic** rồi boost top |
| 5 | Auto-publish | Phase 1-3 anh duyệt, Phase 4+ auto nếu confidence > 80% |

### IMPORTANT (em proceed một phần được)

3. **YouTube OAuth re-grant**: Anh login `app.sondervn.com/admin/youtube-auth` (5 phút) — cấp scope `youtube.upload`
4. **TikTok API account**: Anh đăng ký [TikTok for Business](https://www.tiktok.com/business) (free, 10 phút)
5. **IG Business** verify đã link Sonder FB Page

---

## 📐 KIẾN TRÚC V5 (đã document đầy đủ trong skill)

### Stack

```
EXISTING (đã có):
├─ vp-marketing (Node.js + better-sqlite3)
├─ Ollama Qwen2.5-7B local (script + ideas VN)
├─ ElevenLabs STS Ngân (voice)
├─ Edge-TTS HoaiMy (draft)
├─ FAL.ai key (Flux + Wan 2.2)
├─ FFmpeg (compose)
├─ FB Graph API (post)
├─ YouTube refresh token (cần fix scope)
├─ Authelia SSO (admin UI gate)
└─ PostHog (Phase 4 — funnel)

ADD MỚI (Phase 1):
├─ GrowthBook (A/B test 3 variants)
├─ /var/sonder-real-footage/ (S3-style storage)
├─ Admin UI upload footage (app.sondervn.com/admin/footage)
├─ Script writer V5 (3 hook variants/post)
├─ Hybrid composer (real + AI overlay)
└─ Cross-platform publisher (FB+IG+TikTok+YT)
```

### Cost projection

| Item | Option A (FAL) | Option B (GPU VPS) |
|---|---|---|
| Qwen2.5 + Edge-TTS | $0 | $0 |
| Claude 3.5 fallback | $5 | $5 |
| FAL Flux + Wan (~30 clips/mo) | $13 | $0 |
| ElevenLabs STS | $5 | $5 |
| GPU VPS rental | – | $50 |
| GrowthBook self-host | $0 | $0 |
| **Subtotal baseline** | **$23/mo** | **$60/mo** |
| Optional Meta Ads | +$200 | +$200 |

**Recommend**: Option A baseline 60 ngày, migrate B nếu volume scale.

---

## 🚦 PHASE GATES

### **Gate 0** (pre-flight)
- ✅ Real footage ≥20 clips
- ✅ 5 decisions confirmed

### **Gate 1** (Week 2)
- ✅ 1 hybrid clip render successful + admin approval

### **Gate 2** (Week 4 — sau 14 clips)
- ✅ ≥2 clips pass all Tier 1 metrics (completion >50%, first-hour engagement >50, DM shares >3, cost <$5)
- ❌ 0 clips pass → STOP, debug + pivot

### **Gate 3** (Week 6)
- ✅ ≥5 clips total achieve all 3 Tier 1 metrics simultaneously
- ❌ Fail → KILL automation

### **Gate 4** (Week 8)
- ✅ Cost per booking <$20 attribution proven
- ✅ Auto-publish enabled cho variants giống winner

### **Gate 5** (Week 12)
- ✅ Monthly ROI report positive
- ❌ Fail → reduce 50% hoặc sunset

---

## 🗑 MODULES CŨ — DANH SÁCH XÓA SAU KHI V5 WORK

⚠️ **CHỈ XÓA sau khi V5 pass Gate 3 (Week 6)** — backup deprecated nhưng có thể fallback.

### Routes cũ (`src/routes/`)
| File | Reason | Action |
|---|---|---|
| `news.ts` | VnExpress remix deprecated v25 | DELETE |
| `stories.ts` | V1 story engine deprecated | DELETE |
| `tips.ts` | V2.1 Tips deprecated | DELETE (nếu tồn tại) |
| `weekend.ts` | V2.2 Weekend deprecated | DELETE (nếu tồn tại) |

### Services cũ (`src/services/`)
| File | Reason | Action |
|---|---|---|
| `ci-auto-weekly.ts` | VnExpress remix deprecated | DELETE |
| `news-publisher.ts` | News module deprecated | DELETE |
| `news-classifier.ts` | News module deprecated | DELETE |
| `news-angle-generator.ts` | News module deprecated | DELETE |
| `news-ingest.ts` (nếu có) | News deprecated | DELETE |
| `story-engine.ts` | V1 cũ | DELETE |
| `tips-engine.ts` (nếu có) | V2.1 deprecated | DELETE |
| `weekend-engine.ts` (nếu có) | V2.2 deprecated | DELETE |
| `tips-composer.ts` | V2.1 deprecated | DELETE |
| `weekend-composer.ts` | V2.2 deprecated | DELETE |
| `product-auto-post/` (folder) | Hard-sell ad copy paused permanent | DELETE |

### Cron schedulers (trong `src/services/scheduler.ts`)
| Cron | Action |
|---|---|
| `0 7 * * *` product-auto-post generate | DELETE block (đã có guard) |
| `0 9 * * *` product-auto-post publish | DELETE block |
| `news-ingest 2h` | DELETE |
| `news-classify` | DELETE |
| `news-angle` | DELETE |
| `0 19 * * 0` weekend-auto | DELETE (already disabled) |
| `monthly story-rotate 28th` | DELETE |
| Anthology cron blocks | KEEP nhưng disabled (vs_anthology_cron_enabled=false) — sẽ replaced bởi V5 |

### DB tables cũ (đánh dấu deprecated, KHÔNG drop ngay vì có data)
- `news_articles`, `news_post_drafts` → archive after 30d
- `tips_videos`, `tips_ideas`, `tips_hook_experiments` → archive
- `weekend_videos`, `weekend_theme_log` → archive
- `auto_post_plan`, `auto_post_history` → archive
- `story_episodes` (V1) → keep (V3 anthology dùng table khác)

### Admin pages (frontend `src/public/admin/`)
- Tips dashboard → DELETE
- Weekend dashboard → DELETE
- News drafts review → DELETE
- Auto-post plan → DELETE
- V1 Story engine → DELETE

→ Cleanup script sẽ build (Phase 6 hoặc khi V5 stable Week 8+).

---

## 💻 KHI ANH SANG MÁY KHÁC — RESUME CHECKLIST

### Bước 1: Sync code (5 phút)

```bash
# Nếu máy chưa có repo
git clone https://github.com/vuotquathuthach209-alt/vp-marketing.git
cd vp-marketing

# Nếu đã có repo
cd /path/to/vp-marketing
git pull origin main
```

### Bước 2: Verify dependencies

```bash
npm install              # cài deps mới (BullMQ, ioredis đã add)
npx tsc --noEmit         # verify TS sạch
```

### Bước 3: Mở Claude Code

Chat với em ở phiên mới:

> "Đọc `docs/V5-CONTENT-PLAN-AND-HANDOFF.md` + `docs/SESSION-HANDOFF-2026-05-06.md` để tiếp tục. Em ở phiên trước đã save skill sonder-content-v5. Tiếp tục Phase 1 V5: deploy GrowthBook + admin UI upload footage + script writer 3 variants."

Em (Claude phiên mới) sẽ tự động:
- Load 8 skills (sonder-content-v5, sonder-storytelling, sonder-cinema, sonder-brand-voice, sonder-tech-sovereignty, sonder-sso-identity, sonder-ecosystem, brand-voice)
- Đọc 2 handoff docs
- Check VPS state (Authelia, Chatwoot, Listmonk, Umami, Twenty CRM, vp-marketing)
- Continue work theo Phase Gates

### Bước 4: Confirm 5 decisions trước Phase 1

Anh trả lời em phiên mới:
- 2 themes OK chưa?
- Volume bao nhiêu posts/tuần?
- Hardware Option A hay B?
- Meta Ads ngay hay đợi 30d?
- Auto-publish: full review hay confidence-based?

### Bước 5: Cung cấp real footage

- Upload 20-30 clips điện thoại từ chú Tuấn / lễ tân
- Em sẽ build admin UI Phase 1, hoặc tạm anh upload qua Telegram bot Sonder

---

## 📊 STATUS HIỆN TẠI (snapshot 2026-05-06)

### Services LIVE trên VPS

| Service | URL | Status |
|---|---|---|
| Authelia SSO | https://auth.sondervn.com | ✅ |
| Chatwoot inbox | https://chat.sondervn.com | ✅ |
| Listmonk email | https://mail.sondervn.com | ✅ |
| vp-marketing dashboard | https://app.sondervn.com | ✅ |
| Umami analytics | https://analytics.sondervn.com | ⏳ chờ DNS anh add |
| Twenty CRM | https://crm.sondervn.com | ⏳ chờ DNS anh add |

### Code modules (vp-marketing)
- ✅ Sonder smartreply (Gemini + Ollama)
- ✅ Chatwoot bridge (Phase 2 commit `24f7aac`)
- ✅ Email automation BullMQ (Phase 3G commit `94456ea`)
- ❌ V3 Anthology (paused, sẽ replaced bởi V5)
- ❌ Hard-sell auto-post (paused permanent)
- ✅ V4 Cinema weekly T7 (giữ nguyên)

### DB settings flags hiện tại
```
product_auto_post_enabled = false      ✅ (paused)
vs_anthology_cron_enabled = false      ✅ (paused)
cinema_cron_enabled = true              ✅ (giữ)
crosspost_nhatot247_disabled = true    ✅
email_automation_enabled = true        ✅ (Phase 3G)
```

### Skills locked (8 skills)
1. `sonder-content-v5` — V5 plan này
2. `sonder-storytelling` — Philosophy + 6-layer
3. `sonder-cinema` — V4 Cinema weekly
4. `sonder-brand-voice` — TTS pattern
5. `sonder-tech-sovereignty` — OSS stack lock
6. `sonder-sso-identity` — 1 account principle
7. `sonder-ecosystem` — 4-system architecture

---

## 🔐 CREDENTIALS SHORTCUT (lưu Bitwarden)

```yaml
Authelia: admin / Sonder@2026SSO!
  → URL: https://auth.sondervn.com
  → Master gate cho mọi *.sondervn.com

Chatwoot: admin@sondervn.com / Sonderyz_Us3SYI2U35EMB
  → URL: https://chat.sondervn.com
  → API: JvHWnJ3QJXN669Qz1qBJAext

Listmonk: admin / Sonder@Mail2026!
  → URL: https://mail.sondervn.com

Resend SMTP: re_UURq9rEg_4m12RfSPPzwXSrrykc4EiCWs
  → Domain: sondervn.com (verified)

VPS: root@103.82.193.74
  → Password: cCxEvKZ0J3Ee6NJG
```

---

## 🎯 PHASE 1 DELIVERABLES (Week 1 — em giao trong 7 ngày)

Sau khi anh confirm 5 decisions + cung cấp footage:

1. **Day 1**: Skill V5 saved (✅ done) + audit modules cũ (✅ done in this doc)
2. **Day 2**: Deploy GrowthBook lên VPS (auth.sondervn.com gate)
3. **Day 3**: Build admin UI upload footage `/admin/footage`
4. **Day 4**: Script writer V5 (3 hook variants per post)
5. **Day 5**: Integrate FAL Flux + Wan 2.2 image+video gen
6. **Day 6**: FFmpeg compose hybrid (real footage + AI overlay)
7. **Day 7**: Render 1 test clip 20s → anh review chất lượng

**Gate 1**: Anh approve 1 hybrid clip → green light Phase 2.

---

## 🛡 RISK MITIGATION (đã document trong skill)

| Risk | Mitigation |
|---|---|
| Real footage không đủ | Backup nano-influencer outreach |
| Meta C2PA AI penalty | Hybrid 60% real + admin review checkbox |
| FAL cost overrun | Cap $30/mo + Telegram alert |
| Quality regression | Anh duyệt mọi post Phase 1-2 |
| Burnout admin review | Auto Phase 4+ confidence > 80% |

---

## 📚 REFERENCE LINKS

### Research sources (10 nguồn, 2026)
- [Facebook Reels Algorithm 2026](https://www.opus.pro/blog/ideal-facebook-reels-length-format-retention)
- [Meta C2PA AI detection penalty](https://transparency.meta.com/governance/tracking-impact/labeling-ai-content/)
- [Vietnam Tourism 2026 — VND 2.6T Tết](https://www.travelandtourworld.com/news/article/data-driven-hospitality-how-vietnams-new-daily-briefings-are-revolutionizing-tourism-in-2026/)
- [Hospitality Social Media 2026](https://arisehotelmarketing.com/social-media-hotel-trends-2026/)
- [Wan 2.1/2.2 hardware](https://www.spheron.network/blog/deploy-wan-2-1-ai-video-generation-gpu-setup/)

### OSS tools verified
- ComfyUI: github.com/comfyanonymous/ComfyUI
- AnimateDiff: github.com/guoyww/AnimateDiff
- Wan2GP: github.com/deepbeepmeep/Wan2GP
- GrowthBook: github.com/growthbook/growthbook
- PostHog: github.com/PostHog/posthog

### Internal docs
- `docs/SESSION-HANDOFF-2026-05-06.md` — phase 1-5 deployment handoff
- `.claude/skills/sonder-content-v5/SKILL.md` — V5 detailed principles
- `.claude/skills/sonder-tech-sovereignty/SKILL.md` — OSS stack lock
- `.claude/skills/sonder-sso-identity/SKILL.md` — Auth principles
- `.claude/skills/sonder-storytelling/SKILL.md` — V3 philosophy (V5 inherits)

---

## ✅ CHECKLIST TỔNG KẾT KHI ANH RESUME

```
□ 1. git pull origin main
□ 2. npm install
□ 3. Đọc 2 docs handoff
□ 4. Confirm 5 strategy decisions
□ 5. Upload real footage 20-30 clips
□ 6. Add DNS analytics + crm (Phase 4-5 finalize)
□ 7. Re-OAuth YouTube scope youtube.upload
□ 8. Đăng ký TikTok for Business
□ 9. Chat Claude: "Tiếp tục Phase 1 V5 theo plan"
□ 10. Approve 1 hybrid clip render → Gate 1
```

---

**Phiên save**: 2026-05-06 ~16:00 ICT
**Total work session**: ~10 giờ
**Skills saved (incremental)**: 2 mới (`sonder-tech-sovereignty`, `sonder-sso-identity`, `sonder-content-v5`)
**Services LIVE**: 4 (Authelia, Chatwoot, Listmonk, vp-marketing)
**Services pending DNS**: 2 (Umami, Twenty CRM)
**Plan tổng**: 16 tuần với 5 gates, kill rule 60d

**🌙 Anh nghỉ ngơi tốt. Mọi thứ đã save GitHub, sang máy nhà chỉ cần `git pull` + chat em.**
