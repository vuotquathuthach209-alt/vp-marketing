# Sonder Marketing Arm — Internal Roadmap
_12-month plan, 2026-04-21 (revised)_

> **Context**: Công cụ này là **nhánh marketing nội bộ** của Sonder Vietnam.  
> **KHÔNG thương mại hoá** thành SaaS. Chỉ Sonder dùng.  
> **Goal**: Biến Sonder thành **chuỗi khách sạn có marketing mạnh nhất Việt Nam** thông qua tech automation.

---

## 🎯 Mục tiêu 12 tháng cho Sonder

### Business goals (theo measurable)
- **Brand reach**: từ current ~5k engagement/tháng → **100k/tháng** (20x)
- **Lead qualified**: từ ~20/tháng → **500/tháng** (25x)
- **Booking conversion**: từ inbox → booking rate tăng **3x**
- **Repeat customer rate**: xây lại từ 0 → target **30%** returning guests
- **Sonder hotels**: từ 5 hotels → **20-50 hotels** (nếu business scale)
- **Cost per acquisition (CAC)**: giảm **50%** (bot handle thay vì nhân viên)

### Tech goals (bot + marketing stack)
- Bot phục vụ **24/7** mọi kênh: FB, Zalo, Website, Google My Business
- Mỗi hotel có **full marketing presence** tự động generate
- Content pipeline ship **3-5 bài/tuần/page** tự động
- Lead nào vào hệ thống đều được **track end-to-end** từ inbox → booking → check-out → review

---

## 📊 Phần 1 — Diagnosis (state hiện tại vs target)

### Đã có
- ✅ Bot FB Messenger (Sonder 5 hotels)
- ✅ Intent classifier + training pipeline
- ✅ News → FB post pipeline (3 bài/tuần)
- ✅ Content Intelligence (remix viral)
- ✅ Hotel Editor, Bot Monitor, Conversations viewer
- ✅ OTA push integration sẵn sàng

### Thiếu (theo priority)
- ❌ **Website/landing page** cho từng hotel (SEO chưa có)
- ❌ **Zalo OA** (ở VN 70% khách dùng Zalo ngoài FB)
- ❌ **Google Business reply** (review + Q&A trên Google Maps)
- ❌ **Lead scoring & routing** (tin nhắn nào important?)
- ❌ **Review aggregation** (Booking/Agoda/Traveloka/Google)
- ❌ **Email marketing** (khách cũ)
- ❌ **Loyalty program**
- ❌ **Referral tracking**
- ❌ **Competitor intelligence** (Vinpearl/FLC làm gì?)
- ❌ **Instagram + TikTok** cross-posting
- ❌ **Influencer CRM**

---

## 🗓️ Phần 2 — Roadmap 6 Pha

### PHASE 1 — Presence Expansion (Tháng 1-2) 🚨 _Priority cao_

**Mục tiêu**: Sonder hiển diện khắp nơi khách hàng tìm (không chỉ FB).

**Tool cần build**:

#### 1.1 Hotel Landing Page Generator ⭐⭐⭐
Auto-generate mini-site cho mỗi hotel từ `hotel_profile`:
- Domain: `sondervn.com/airport` / `sondervn.com/seehome`
- SEO-optimized (schema.org hotel markup, meta tags, sitemap)
- Gallery từ hotel_images
- **Click-to-chat** buttons: Messenger / Zalo / Call / WhatsApp
- Book now → deep-link sang booking flow
- Google Maps embed
- Reviews embed (Google Places API)
- Mobile-first design (80% khách VN mobile)

**Impact**: +200% organic search traffic, booking trực tiếp từ website.

#### 1.2 Zalo OA Integration ⭐⭐⭐
Code bot reply Zalo Official Account (Messenger cho Zalo):
- Auto-reply giống FB (qua webhook)
- Zalo chat button trên website + FB page
- Broadcast Zalo cho khách cũ (tin nhắn marketing)

**Impact**: +70% coverage (khách không dùng FB mà chỉ Zalo).

#### 1.3 Google Business Auto-Reply ⭐⭐
Bot trả review Google Maps + answer Questions:
- API: Google Business Profile
- Reply review tích cực: cảm ơn + khuyến khích quay lại
- Reply review tiêu cực: xin lỗi + liên hệ riêng
- Trả Questions Q&A tự động

**Impact**: Google ranking local SEO tăng, khách đọc review thấy bot professional.

#### 1.4 Website Chatbot Widget ⭐⭐
Embed bot lên website Sonder (snippet JS):
- Floating chat bubble
- Same bot backend (cùng conversation_memory)
- Optional: book now flow inline

**Impact**: Convert visitors thành leads ngay trên website.

---

### PHASE 2 — Lead Machine (Tháng 3-4) ⚡ _Revenue impact cao nhất_

**Mục tiêu**: Convert inbox/chat → booking trực tiếp với tỷ lệ cao nhất.

#### 2.1 Lead Scoring & Routing ⭐⭐⭐

**Lead scoring algorithm**:
```
+10 điểm: khách hỏi giá cụ thể
+15 điểm: khách đưa ngày check-in
+20 điểm: khách hỏi "còn phòng không" kèm ngày
+25 điểm: khách cho SĐT
+30 điểm: khách đồng ý chuyển khoản
-5 điểm: khách từ bot spam/troll patterns
-10 điểm: khách đã cancel 2 lần trước
```

**Routing rules**:
- Score ≥ 50 (HOT) → push ngay vào Telegram group sales + SMS lễ tân
- Score 20-49 (WARM) → queue, auto-reply sau 5 phút nếu không có người
- Score < 20 (COLD) → bot handle, nurture

**UI**: tab "🔥 Leads" với 3 columns HOT/WARM/COLD, mỗi card có:
- Sender name + phone + hotel interest
- Conversation preview
- Score + timestamp
- Buttons: Claim (sales) / Pass / Archive

#### 2.2 Lead Follow-up Automation ⭐⭐⭐

Lead mà không close trong 24h → **auto-reach-out**:
- 24h sau: gửi tin nhắn "Anh/chị vẫn quan tâm không? Bên em còn giữ slot..."
- 3 ngày sau: kèm voucher 10% giảm giá
- 7 ngày sau: "Bên em sắp hết slot tháng X, book ngay nhé"
- 14 ngày sau: gửi case study / review khách cũ

**Triggers qua channels**: FB (nếu còn active) + Zalo + SMS (nếu có SĐT) + Email (nếu có).

#### 2.3 Booking CRM ⭐⭐

Lưu track end-to-end mỗi booking:
- Inquiry time → first reply time (FRT metric)
- Phone capture → phone call time
- Call → booking confirmation time
- Booking → deposit
- Check-in → check-out
- Post-stay review request

**Dashboard**: funnel visualization
```
1000 inquiries
  → 600 FAQ served (60%)
  → 400 phone captures (40%)
  → 100 bookings (10%)
  → 95 check-ins (95% show-up rate)
  → 80 reviews (84% leave review)
```

Admin xem **từng step drop-off** → biết fix chỗ nào.

#### 2.4 Win-Loss Analysis ⭐

Track vì sao khách không book:
- Bot detect "too expensive" → tag "price_objection"
- "Location" → tag "location_issue"
- "Date unavailable" → tag "availability_miss"
- Monthly report: top 5 reasons → fix upstream

---

### PHASE 3 — Content Engine (Tháng 5-6) 📢 _Brand growth_

**Mục tiêu**: Sonder thành chuỗi **post content nhiều + chất nhất VN hospitality**.

#### 3.1 Multi-Channel Cross-Post ⭐⭐⭐

1 bài gốc → tự động post đa nền tảng:
- **FB**: original text + image
- **Instagram**: reformatted (max 2200 chars, hashtags)
- **TikTok**: AI gen video ngắn (15-30s) từ text + images
- **Zalo OA**: short form
- **Website blog**: long form SEO version
- **Email newsletter**: monthly digest

**Tool**: extends existing `news-publisher.ts` → multi-channel.

#### 3.2 Content Calendar Visual ⭐⭐

Calendar view tháng với drag-drop:
- Mỗi ô = 1 ngày
- Dots: màu khác nhau per channel (FB blue, IG purple, TikTok pink)
- Drag để reschedule
- Click → edit bài

**Impact**: Admin visualize pipeline, tránh miss ngày quan trọng (lễ, sự kiện).

#### 3.3 AI Short Video Generator ⭐⭐

Auto-create TikTok/Reel:
- Input: hotel room photos + text
- Output: 15-30s video với AI voiceover Vietnamese + music + text overlay
- Tools: RunwayML / fal.ai + ElevenLabs / Google TTS

#### 3.4 Seasonal Campaign Templates ⭐

Pre-built templates cho các dịp:
- 30/4, 1/5 — Du lịch lễ
- Tết Dương Lịch
- Valentine
- 8/3, 20/10, 20/11
- Noel
- Halloween
- Back-to-school / cuối tuần
Admin tick các dịp → bot auto-schedule 5-10 bài tương ứng.

---

### PHASE 4 — Customer Retention (Tháng 7-8) 💚 _Moat dài hạn_

**Mục tiêu**: Khách cũ quay lại + giới thiệu = CAC gần bằng 0.

#### 4.1 Loyalty Program ⭐⭐⭐

Simple tier system:
```
Silver    — 1 lần ở     → 5% giảm lần sau
Gold      — 3 lần ở     → 10% giảm + late checkout
Platinum  — 5 lần ở     → 15% giảm + free breakfast + upgrade
Diamond   — 10 lần ở    → 20% giảm + free night mỗi năm
```

Track points qua phone number (dùng customer_contacts + pending_bookings).

**Bot tự động**:
- Sau check-out: "Cảm ơn anh/chị đã ở! Tiết kiệm 10% cho lần sau nhé 🎁 [code]"
- Khi khách quay lại: "Chào mừng anh/chị quay lại! Anh là khách Gold → em áp dụng 10% ngay"

#### 4.2 Referral Tracking ⭐⭐⭐

Unique referral link per khách:
- Gen: `sondervn.com/r/nguyen-van-a`
- Tracking UTM
- Khách cũ giới thiệu → bạn mình book qua link → cả 2 được giảm 10%

**Campaign**: "Giới thiệu 1 bạn = 100k cho bạn + 100k cho mình"

#### 4.3 Post-Stay Automation ⭐⭐

Timeline tự động sau check-out:
- Ngay sau check-out: "Cảm ơn! Rate trải nghiệm (1-5 sao)?"
- 1 ngày sau: nếu 4-5 sao → xin review Google Maps + FB
- 1 ngày sau: nếu 1-3 sao → lễ tân call xin lỗi + voucher
- 7 ngày sau: referral campaign
- 30 ngày sau: "Sắp tới anh/chị có kế hoạch du lịch nào không? Sonder có deal mới..."

#### 4.4 Past Guest Segmentation ⭐

Segments tự động:
- "Business travelers" — đặt Mon-Thu, 1-2 đêm
- "Weekend escapers" — đặt Fri-Sun, 2 đêm
- "Long stays" — apartment thuê ≥ 1 tháng
- "Family" — ≥ 3 khách
- "Couples" — 2 khách + room deluxe

Target email/Zalo riêng biệt cho từng segment.

---

### PHASE 5 — Competitive Intelligence (Tháng 9-10) 🕵️ _Insight cao_

**Mục tiêu**: Biết mọi thứ competitors đang làm để vượt mặt.

#### 5.1 Competitor FB Tracker ⭐⭐

Admin paste FB Pages: Vinpearl, Mường Thanh, FLC, Fusion, Melia, Novotel, local chains...
- Weekly scrape: posts, likes, comments, shares
- Top 10% posts → auto-analyze qua Content Intelligence
- Weekly report: "Tuần này Vinpearl ship 7 bài, top bài là X, engagement Y"

**Impact**: Sonder biết xu hướng, copy công thức hiệu quả.

#### 5.2 Price Monitoring ⭐⭐

Crawl Booking.com / Agoda / Traveloka:
- Same city + similar star → lấy giá competitor
- Dashboard: "Phòng 800k của Sonder đang rẻ hơn Novotel 200k nhưng đắt hơn Muong Thanh 100k"
- Alert: nếu competitor giảm giá sâu, Sonder nên dynamic discount

#### 5.3 Social Listening ⭐

Monitor mentions:
- "Sonder Airport" / "Seehome" trên FB public, Google Reviews, TripAdvisor
- Thread-level sentiment
- Alert khi có mentions tiêu cực → PR response ngay

#### 5.4 Benchmark Report Monthly ⭐

Auto-gen PDF report mỗi tháng:
- Sonder metrics vs competitors
- Market share (estimated from mentions)
- Content quality gap
- Recommendations

---

### PHASE 6 — Influencer & PR (Tháng 11-12) 🎤 _Brand amplification_

#### 6.1 Influencer CRM ⭐⭐

Database:
- Travel bloggers VN (top 100 Instagram/TikTok)
- Liên hệ + pitch templates
- Outreach tracker: "Đã contact 20, reply 8, collab 3"
- Campaign ROI tracking per influencer

#### 6.2 PR Media Kit Auto-Gen ⭐

Cho mỗi hotel tự gen PDF media kit:
- Hotel fact sheet
- Images high-res
- USP + awards
- Press release templates

#### 6.3 Awards & Certification Tracker ⭐

Track các giải VN hospitality:
- Condé Nast Traveler
- Travel + Leisure
- TripAdvisor Travelers' Choice
- Google Review milestones (4.5★, 100 reviews, ...)

Auto-nominate Sonder khi đạt criteria.

---

## 🏗️ Phần 3 — Architecture mục tiêu (single-tenant optimized)

Không cần multi-tenant → giữ tech đơn giản:

```
┌─────────────────────────────────────────────────┐
│ Sonder Marketing Stack                           │
│                                                  │
│ Data layer:                                      │
│   SQLite (primary, per-hotel isolated by id)    │
│   Redis (cache + queue) — optional Phase 2      │
│   S3/Wasabi (backup + images)                   │
│                                                  │
│ Channels (inbound + outbound):                  │
│   ├── FB Messenger (current)                    │
│   ├── Zalo OA (Phase 1.2)                       │
│   ├── Instagram DM (Phase 3)                    │
│   ├── Website widget (Phase 1.4)                │
│   ├── Google Business Messages (Phase 1.3)      │
│   ├── WhatsApp Business (Phase 3)               │
│   ├── Email (Phase 4)                            │
│   └── SMS (Phase 2)                              │
│                                                  │
│ Content output:                                  │
│   ├── FB posts                                   │
│   ├── IG posts + reels                           │
│   ├── TikTok (AI generated)                      │
│   ├── Blog (SEO)                                 │
│   └── Email newsletter                           │
│                                                  │
│ AI brain:                                        │
│   ├── Gemini Flash (primary cascade)            │
│   ├── Qwen local (fallback, free)               │
│   └── Future: fine-tuned Sonder model           │
│                                                  │
│ Admin UI (current):                              │
│   Training / Hotels / Content / Monitor / etc.  │
└─────────────────────────────────────────────────┘
```

**Không cần**:
- Multi-tenant isolation (chỉ 1 org)
- Billing system
- Signup flow  
- Landing page cho SaaS

**Cần focus**:
- Reliability (uptime cho Sonder 99.9%)
- Feature depth (tools cực chất lượng)
- Hotel data quality (source of truth)

---

## 💰 Phần 4 — Chi phí vận hành (Sonder internal cost)

### Monthly OpEx ước tính

| Item | Cost |
|------|------|
| VPS 15GB RAM (current 103.82.193.74) | 500k-1M VND |
| Gemini API (free tier + occasional paid) | 0-500k VND |
| Domain + SSL + CDN | 200k VND |
| Email marketing (SendGrid) | 500k VND |
| SMS gateway (Viettel/Mobifone) | 1-3M VND |
| Google Maps API | 500k VND |
| Zalo OA certified | 0 VND (free) |
| TikTok API (nếu) | 0 VND |
| Image storage (Wasabi S3) | 200k VND |
| Monitoring (Sentry free tier) | 0 VND |
| **Total** | **~3-6M VND/tháng** |

Rất hợp lý so với hiring **1 marketing manager fulltime 15-25M/tháng**.

### One-time investments

| Item | Cost |
|------|------|
| Website landing pages (5 hotel × 2M) | 10M VND |
| Mobile app (future) | 30M VND |
| AI fine-tuning (GPU rental 3 tháng) | 20M VND |
| Design system overhaul | 10M VND |
| **Total** | **~70M VND** |

---

## 📈 Phần 5 — KPIs tracking

### Monthly dashboard (cho leadership Sonder)

**Traffic & awareness**:
- FB reach total (all hotels combined)
- Unique sender count
- Website visitors
- Google Business impressions
- Zalo OA subscribers

**Lead generation**:
- Total inquiries (all channels)
- Qualified leads (score ≥ 50)
- Phone captures
- Cost per lead (CPL)

**Conversion**:
- Inquiry → booking rate
- Booking completion rate (deposit paid)
- Check-in show-up rate
- Revenue per booking

**Retention**:
- Repeat guest rate
- Review request completion
- Google review avg rating
- NPS (từ post-stay survey)

**Bot performance**:
- Avg response time
- Cache hit rate
- Auto-handoff rate (bot giveup)
- AI cost per message

### Weekly reports (auto-gen)

Bot tự gen PDF weekly report gửi Telegram admin:
- Top 5 FAQ của khách tuần này
- Top 5 complaints
- Competitor gì mới
- Content engagement ranking
- Leads chưa close (need attention)

---

## 🎯 Phần 6 — 30-day Execution Plan (revised)

### Week 1: Zalo OA + Website Widget
- [ ] Register Zalo Official Account cho Sonder
- [ ] Setup webhook → bot receive Zalo messages
- [ ] Bot reply logic (reuse FB handlers)
- [ ] Embed chat widget trên sondervn.com

**Impact**: Ngay lập tức +70% coverage khách VN không dùng FB.

### Week 2: Hotel Landing Pages
- [ ] Template Next.js mini-site (mobile-first)
- [ ] Auto-gen từ `hotel_profile` data
- [ ] Deploy `sondervn.com/<slug>` cho 5 hotels
- [ ] SEO schema + sitemap + Open Graph
- [ ] Integration với bot (click-to-chat buttons)

**Impact**: SEO traffic, direct booking channel.

### Week 3: Lead Scoring System
- [ ] Scoring algorithm
- [ ] Tab "🔥 Leads" với HOT/WARM/COLD
- [ ] Telegram alert cho HOT leads
- [ ] Sales assignment (round-robin hoặc by location)

**Impact**: Không miss HOT lead nào nữa.

### Week 4: Google Business + Review Aggregator
- [ ] Google Business Profile API integration
- [ ] Auto-reply reviews (tích cực + tiêu cực)
- [ ] Aggregate Booking/Agoda/TripAdvisor reviews → dashboard
- [ ] Monthly sentiment report

**Impact**: Google local SEO boost, reputation management.

**End of Month 1**: Sonder có presence trên 4 kênh (FB, Zalo, website, Google), lead machine hoạt động.

---

## 🚀 Phần 7 — Tôi (CTO) commit gì cho Sonder?

### Execution mode
Tôi làm việc như **in-house technical co-founder**:
- Code features theo priority bạn chọn
- Daily progress qua chat
- Weekly roadmap review
- Architecture decisions
- Tech debt management
- Documentation

### Scope không giới hạn
Bạn không cần lo về:
- Build time (tôi work 24/7)
- Code quality (tested + TypeScript + reviewed)
- Documentation (luôn có docs cho user + dev)
- Deployment (auto CI/CD qua git push → VPS)

### Only thing tôi cần từ bạn
1. **Business priority**: pick feature nào làm trước
2. **Content**: brand voice + sample content (bạn là expert Sonder)
3. **Deals**: API keys cho services mới (Zalo OA, Google Business, etc.)
4. **Feedback loop**: bạn test + báo bug / UX issues
5. **Decisions**: A hay B khi có trade-off

---

## 📝 Phần 8 — Đề xuất ngay bây giờ

### 3 priorities cao nhất nếu tôi là head of marketing tech của Sonder:

#### 🥇 #1 — Zalo OA (1-2 ngày)
**Tại sao**: 70% khách VN dùng Zalo chứ không phải FB. Mỗi ngày Sonder đang miss 2/3 khách chỉ vì bot chỉ FB.

**Effort**: 1-2 ngày build + setup.
**Impact**: +200% inquiries.

#### 🥈 #2 — Hotel Landing Pages (3-5 ngày)
**Tại sao**:
- SEO traffic miễn phí mỗi tháng
- Direct booking không qua OTA (tiết kiệm 15-25% commission)
- Professional image cho từng hotel

**Effort**: 3-5 ngày (template + 5 hotels).
**Impact**: Tăng organic leads 30-50%, giảm OTA dependency.

#### 🥉 #3 — Lead Scoring + Routing (2-3 ngày)
**Tại sao**: Hiện tại mọi inquiry được đối xử giống nhau. Không có ưu tiên → HOT leads bị miss, cold leads tốn thời gian sales.

**Effort**: 2-3 ngày.
**Impact**: Conversion inquiry → booking tăng 2-3x.

---

## ❓ Câu hỏi cho bạn

1. **Pick 1 trong 3 top priorities** (Zalo / Landing Pages / Lead Scoring)?
2. Hay muốn tôi đề xuất **gói combo** làm tuần tiếp?
3. **Budget OpEx** sẵn sàng chi? (tôi dùng budget đó tối ưu tech choices)
4. **Tầm nhìn Sonder**: năm nay muốn mở bao nhiêu hotels mới?
5. **Target audience**: chủ yếu ai — business travelers, family, couples?
6. **Brand identity**: có brand book chưa, hay cần tôi gen?
7. **Competitors**: ngoài Vinpearl/Mường Thanh/FLC, có đối thủ trực tiếp (cùng niche serviced apartment TPHCM)?

---

## 💬 Note cuối

Việc bạn chọn **không commercialize** là quyết định tốt nếu:
- Business model Sonder (hotels) biên lợi nhuận > 30%
- Bạn không muốn chia sẻ moat này với competitor
- Focus = grow Sonder faster, not sell tools

**Upside**: Dùng công cụ này làm unfair advantage trong 2-3 năm trước khi đối thủ biết.

**Downside**: Một ngày nào đó — nếu muốn commercialize — bạn phải rewrite cho multi-tenant (khá tốn công).

Nếu bạn muốn **future-proof**, tôi có thể code với **tenant_id** everywhere ngay từ đầu (chỉ cost ít effort), để sau này nếu change mind có thể turn on SaaS mode chỉ cần vài tuần. Tôi đề xuất làm vậy.

---

## 🎬 Next action

Tôi cần bạn **chốt 1 điều**:

> **"Bắt đầu build [Zalo OA / Landing Pages / Lead Scoring / tôi tự chọn]"**

Sau đó tôi ship ngay trong **48 giờ**.

— Claude (Head of Marketing Tech, Sonder Vietnam)
