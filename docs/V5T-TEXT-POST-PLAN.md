# 📸 V5T TEXT/IMAGE POST PLAN — HANDOFF

> **Created**: 2026-05-06 (phiên Sonder)
> **Skill reference**: `.claude/skills/sonder-content-v5t/SKILL.md`
> **Sister doc**: `docs/V5-CONTENT-PLAN-AND-HANDOFF.md` (V5 Reels)

---

## ⚡ TLDR

```
DIAGNOSE: 22/22 photo posts last 30 days = 100% engagement = 0
  → Page Sonder bị Meta SUPPRESS REACH do hard-sell pattern lặp lại.

SOLUTION V5T:
  ├─ Recovery 6-12 tuần (kiên nhẫn)
  ├─ Hybrid 60% real photo + 30% AI-assist + 10% pure AI
  ├─ Carousel format (research: -30-50% cost/conversion vs single)
  ├─ 7 hook patterns (text-form same V5 family)
  ├─ Community engagement: poll + question + reply 100%
  ├─ Frequency: 3-5 V5T posts/tuần (mix với 5 V5 Reels)
  └─ Kill rule 60d (same V5 framework)
```

---

## 🎯 PRE-FLIGHT (anh chuẩn bị trước Phase 1)

### CRITICAL #1: Real footage initial batch (60% pillar)
Anh ask chú Tuấn / lễ tân chụp **20-30 ảnh điện thoại**:

| Type | Examples |
|---|---|
| **Property tour** | Phòng từ 4-5 góc khác nhau, sảnh, view, hành lang |
| **Staff in action** | Chú Tuấn pha trà (close-up tay), lễ tân ghi sổ |
| **Amenities** | Trà gừng + cốc, sách trên kệ, chìa khoá đồng |
| **Neighborhood** | Quán phở 6h sáng, cafe đối diện, hẻm Bình Thạnh |
| **Macro details** | Logo Sonder trên cốc, ga giường, đèn vàng |

**Format**: vertical hoặc square 1:1, không cần edit, raw OK
**Time**: ~1-2h tổng cho 30 ảnh
**Storage**: `/var/sonder-real-footage/` (cùng V5 video)

### CRITICAL #2: 5 quyết định strategy V5T

| # | Câu hỏi | Em recommend |
|---|---|---|
| 1 | Post type mix | 40% carousel + 30% single image + 15% poll + 15% UGC |
| 2 | V5T frequency | 3 posts/tuần (T3/T5 carousel, CN poll) |
| 3 | Auto-publish | Phase 1-3 anh duyệt, Phase 4+ confidence-based |
| 4 | Caption language | 100% Vietnamese (Sonder voice) |
| 5 | Reply automation | AI draft → anh duyệt 1-click qua Chatwoot |

---

## 📋 V5T POST TYPES (4 templates lock)

### Type 1: CAROUSEL (40% V5T)
- 4-6 images
- Image 1 = hero text overlay (hook 1 dòng)
- Use case: phòng tour, walking guide

### Type 2: SINGLE IMAGE + STORY (30%)
- 1 high-quality real photo
- Caption: hook + story 4-6 dòng + closing poetic

### Type 3: POLL/QUESTION (15%)
- FB native poll OR question post
- Trigger spontaneous comment

### Type 4: UGC REPOST (15%)
- Khách tag #sondervn / @sondervn
- Auto-detect → notify Telegram → 1-click repost

---

## 🛠 STACK V5T (zero new infra)

### Tái sử dụng V5 (đã deploy)
- `/var/sonder-real-footage/` — repo ảnh + video chung
- FAL Flux ($0.025/image)
- Qwen2.5 + Claude (caption gen)
- GrowthBook (A/B test)
- PostHog (analytics)
- Chatwoot (reply automation)
- /admin/v5/dashboard pattern

### Code mới cần build (~16 days)

```
src/services/v5t/
├─ types.ts                  — TS interfaces
├─ post-writer.ts            — caption + 3 hook variants
├─ carousel-composer.ts      — sharp grid + text overlay
├─ poll-generator.ts         — poll/question gen
├─ publisher.ts              — FB photo/carousel/poll API
└─ orchestrator.ts           — 3 stages: gen/render/post

src/routes/
└─ v5t-admin.ts              — dashboard /admin/v5t

DB tables:
├─ v5t_posts                 — posts với type, caption, status
├─ v5t_post_images           — 1-N images per post
└─ v5t_ab_results            — A/B test 3 hooks
```

---

## 📐 SCHEDULE (mix V5 Reels + V5T + Cinema)

```
Tuần điển hình:

T2 (Mon)  19:00  V5 Reels (Sài Gòn Insider)
T3 (Tue)  10:00  V5T Carousel (property tour)
T4 (Wed)  19:00  V5 Reels (Sonder BTS)
T5 (Thu)  10:00  V5T Single image + story
T6 (Fri)  19:00  V5 Reels (Sài Gòn Insider)
T7 (Sat)  20:30  V4 Cinema weekly
CN (Sun)  10:00  V5T Poll/question (community)

Total: 7 posts/tuần (5 Reels + 2 image + 1 poll)
```

---

## 📅 ROADMAP 8 TUẦN với GATES

### **Phase 1** (Week 1-2 — Foundation)

#### Day 1-2: DB + Types
- [ ] Extend `v5_footage` cho image type (`media_type` column)
- [ ] Add tables: `v5t_posts`, `v5t_post_images`, `v5t_ab_results`
- [ ] Build `src/services/v5t/types.ts`

#### Day 3-4: Post writer
- [ ] `src/services/v5t/post-writer.ts`
- [ ] Caption gen với Qwen2.5 + Claude fallback
- [ ] 3 hook variants A/B/C (same patterns V5)
- [ ] Hashtag library (50 Sonder niche tags)
- [ ] Anti-pattern validation (no hard-sell, no bait)

#### Day 5-6: Carousel composer
- [ ] `src/services/v5t/carousel-composer.ts`
- [ ] Sharp library: image resize + text overlay
- [ ] Output: 1080×1080 single OR 1080×1080 carousel (4-6 frames)

#### Day 7-8: Publisher
- [ ] `src/services/v5t/publisher.ts`
- [ ] FB photo: POST `/me/photos` with caption
- [ ] FB carousel: POST `/me/feed` với `child_attachments`
- [ ] FB poll/question: POST với `attached_media` + poll structure

**GATE 1**: 1 carousel render thành công + admin approval

### **Phase 2** (Week 3-4 — Pilot)

#### Day 9-10: Admin UI
- [ ] `src/routes/v5t-admin.ts`
- [ ] Dashboard /admin/v5t (giống V5 pattern)
- [ ] Generate-now + Approve/Reject

#### Day 11-12: Cron + orchestrator
- [ ] `src/services/v5t/orchestrator.ts`
- [ ] Cron: T3/T5 10:00 carousel, T7/CN 10:00 poll
- [ ] Settings flags: `v5t_cron_enabled`, `v5t_auto_publish`

#### Day 13-14: Reply automation
- [ ] Hook into Chatwoot comments
- [ ] Smartreply draft → Telegram notify anh
- [ ] 1-click approve reply

**GATE 2**: ≥2/6 pilot posts achieve >5 engagement

### **Phase 3** (Week 5-6 — Production)

- Daily V5T pilot per schedule
- Monitor metrics → optimize hook patterns
- A/B test winner reuse

**GATE 3**: ≥10 posts đạt all Tier 1 metrics

### **Phase 4** (Week 7-8 — Scale)

- Auto-publish enabled (confidence > 80%)
- Meta Ads conversion campaign $200/tháng (boost top performers)
- UGC outreach + repost flow

**GATE 4**: Page reach +50% recovery

---

## 📊 SUCCESS METRICS (Tier 1/2/3)

### Tier 1 — MUST HIT (60d kill rule)

| Metric | Target | Hiện tại |
|---|---|---|
| Image post avg engagement | **>5 reactions/post** | 0 🔴 |
| Carousel completion rate | **>50% swipes** | N/A |
| Reply rate trong 1h | **100%** | 0% 🔴 |
| Page reach trend 4 weeks | **+50%** | -100% 🔴 |
| Cost per image post | **<$0.10** | TBD |

### Tier 2 — SHOULD HIT
- Save rate >1%
- Brand mentions in comments >5/tuần
- Cost per booking <$15

### KILL RULE
- 60d, 2+ Tier 1 fail → STOP
- All Tier 1 pass → green light Phase 4+

---

## 💰 COST PROJECTION

| Item | Cost/tháng |
|---|---|
| Tái sử dụng V5 infra | $0 |
| FAL Flux (~30 images/mo) | $1 |
| Caption gen (Qwen local + Claude fallback) | $1 |
| **Subtotal V5T** | **$2/tháng** |
| Optional Meta Ads boost | $200 |

→ **V5T zero-cost extra** ngoài V5.

---

## 🚦 KHI ANH SANG MÁY KHÁC

### Bước 1: Sync code

```bash
cd /path/to/vp-marketing
git pull origin main
npm install
```

### Bước 2: Mở Claude Code → chat:

> "Đọc `docs/V5T-TEXT-POST-PLAN.md` + `docs/V5-CONTENT-PLAN-AND-HANDOFF.md` để tiếp tục.
> Em đã save skill `sonder-content-v5t`. Continue Phase 1 V5T:
> Day 1 — extend v5_footage table + add v5t_* tables + types.ts."

### Bước 3: Em (Claude phiên mới) tự động:
- Load 9 skills (V5 + V5T + tech-sovereignty + sso-identity + ...)
- Đọc 2 handoff docs
- Check VPS state (V5 cron đã enabled từ 06/05)
- Continue work theo Phase Gates

### Bước 4: Anh chuẩn bị

Trước khi resume Phase 1 V5T:
1. Upload 20-30 real photos (chú Tuấn/lễ tân điện thoại)
2. Confirm 5 strategy decisions
3. Anh đã review 3 V5 Reels variants chưa? Quyết định auto-publish?

---

## 📋 STATUS HIỆN TẠI (snapshot 2026-05-06 evening)

### Đã làm hôm nay (phiên này)

| Item | Status |
|---|---|
| **V5 Reels Phase 1 + 2** | ✅ Pipeline complete (Day 1-12) |
| Skill `sonder-content-v5` | ✅ saved + committed |
| Skill `sonder-content-v5t` (V5T) | ✅ saved (NEW) |
| Cron V5 enabled (17h gen / 19h publish) | ✅ Lần đầu chạy 17h hôm nay |
| Dashboard `/admin/v5/dashboard` | ✅ LIVE |
| 5 V5 Reels variants render thành công (Gate 1) | ✅ |
| Admin UI footage upload `/admin/footage` | ✅ |
| GrowthBook A/B test platform | ✅ LIVE |
| Voice synth integration (Edge → ElevenLabs) | ✅ |

### Còn lại (cho phiên máy nhà)

#### V5 Reels (Phase 2 finalize)
- [ ] Anh review 5 variants đã render → quyết định approve workflow
- [ ] Lần chạy auto đầu tiên 17h hôm nay (T4 6/5)
- [ ] Monitor 14 clips trong Week 3-4 → Gate 2

#### V5T Text/Image (Phase 1 — chưa bắt đầu)
- [ ] All 16 days roadmap (em làm khi anh resume)

#### Phase 4-5 finalize (đợi DNS)
- [ ] Anh add DNS analytics + crm
- [ ] Setup Umami tracker cho sondervn.com OTA
- [ ] Twenty CRM custom schema

---

## 📚 SKILLS SAVED (9 total — mọi phiên Claude load)

1. `sonder-content-v5` — V5 Reels strategy
2. `sonder-content-v5t` — V5T Text/Image strategy (NEW)
3. `sonder-storytelling` — Philosophy + character pool
4. `sonder-cinema` — V4 Cinema weekly
5. `sonder-brand-voice` — TTS pattern
6. `sonder-tech-sovereignty` — OSS stack lock
7. `sonder-sso-identity` — 1 account principle
8. `sonder-ecosystem` — 4-system architecture

---

## 🔐 CREDENTIALS (lưu Bitwarden)

| Service | Username | Password |
|---|---|---|
| Authelia | `admin` | `Sonder@2026SSO!` |
| Chatwoot | `admin@sondervn.com` | `Sonderyz_Us3SYI2U35EMB` |
| Listmonk | `admin` | `Sonder@Mail2026!` |
| Resend SMTP | – | `re_UURq9rEg_4m12RfSPPzwXSrrykc4EiCWs` |
| VPS | `root@103.82.193.74` | `cCxEvKZ0J3Ee6NJG` |

---

## ✅ CHECKLIST RESUME TỪ MÁY NHÀ

```
□ 1. git pull origin main
□ 2. npm install
□ 3. Đọc docs/V5T-TEXT-POST-PLAN.md (file này)
□ 4. Upload 20-30 real photos qua /admin/footage/upload
□ 5. Confirm 5 V5T strategy decisions
□ 6. Chat Claude: "Continue Phase 1 V5T"
□ 7. Em build Day 1-2 (DB + types)
□ 8. Em build Day 3-8 (writer + composer + publisher)
□ 9. Em build Day 9-14 (admin UI + cron + reply)
□ 10. Pilot 6 V5T posts → Gate 2 verification
```

---

## 🎬 PARALLEL TRACK (V5 Reels đã chạy auto)

Phiên hôm nay V5 Reels cron **đã được enable** — sẽ tự chạy 17h chiều hôm nay (T4 6/5):
- 17:00 — Generate 1 script + render 3 variants
- 19:00 — Auto publish all 3 variants lên FB Reels (cách 30s)

→ Anh có thể track real-time tại https://app.sondervn.com/admin/v5/dashboard.

V5T sẽ chạy **song song** sau khi anh resume + em build pipeline (~16 days).

---

**Ngày save**: 2026-05-06 ~17:00 ICT
**V5 Reels status**: ✅ Active + cron enabled
**V5T Text/Image status**: 📋 Plan saved, chưa start build
**Plan tổng**: 8 tuần với 4 gates, kill rule 60d

🌙 **Anh nghỉ ngơi tốt. Sang máy nhà chỉ cần `git pull` + chat em "Continue V5T".**
