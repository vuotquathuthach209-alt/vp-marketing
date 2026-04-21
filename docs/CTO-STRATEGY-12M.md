# CTO Strategy — VP Marketing Bot → SaaS Platform
_12-month roadmap, 2026-04-21_

> **Tầm nhìn**: Biến internal tool của Sonder thành **#1 chatbot chuyên ngành lưu trú tại Việt Nam**.

---

## 📊 Phần 1 — Honest Assessment (đánh giá thẳng)

### Điểm mạnh hiện tại
- ✅ **Product** hoạt động thực (Sonder đang dùng, có traffic thật)
- ✅ **AI stack** rẻ (Gemini Flash free + Qwen local) — lợi thế cost
- ✅ **Dữ liệu độc quyền**: 326+ news articles, 247+ hotel conversations, 89 classified intents
- ✅ **Vertical expertise**: chuyên sâu hospitality VN (apartment thuê tháng vs hotel thuê đêm — niche khó copy)
- ✅ **Tech moat đang build**: Intent Confidence Heatmap + Training Pipeline + Content Intel là những thứ chưa competitor VN nào có
- ✅ **8 admin tools** — công cụ đã hoàn chỉnh cho 1 chain 5-20 hotels

### Điểm yếu cần fix GẤP
- ❌ **Single-tenant hard-coded**: chỉ 1 Sonder. Không thể onboard hotel khác
- ❌ **Single SQLite**: limit ~100 hotels trước khi performance issue
- ❌ **No billing**: không có cách thu tiền khách hàng
- ❌ **No self-serve onboarding**: hotel mới muốn dùng phải liên hệ thủ công
- ❌ **FB-only channel**: Zalo / website widget / Google Business chưa có
- ❌ **No marketing site**: app.sondervn.com chỉ là admin panel, không có landing page
- ❌ **Data isolation**: không có tenant-level encryption / access control

### Thị trường cơ hội (ước tính)

**TAM (Total Addressable Market) — VN hospitality**:
- ~100 boutique hotel chains (5-50 hotels/chain)
- ~5,000 khách sạn độc lập 3-5 sao
- ~10,000 homestay / apartment chains
- ~2,000 resort / retreat

Ước tính **15,000 properties** có thể là target. Mỗi tháng 500k VND → **TAM = 7.5 tỷ VND/tháng = 90 tỷ/năm**.

**SOM (Serviceable Obtainable Market) 3 năm đầu**:
- Năm 1: 50 paying customers (chủ yếu homestay + chain nhỏ) → 300 triệu MRR
- Năm 2: 500 customers → 3 tỷ MRR
- Năm 3: 2,000 customers → 12 tỷ MRR = 144 tỷ ARR

### Competitors (đã research)

| Tên | Pros | Cons | Khoảng giá |
|-----|------|------|-----------|
| ManyChat (global) | Ecosystem mạnh, tích hợp IG/WhatsApp | Không chuyên VN, không hiểu hospitality | $15-145/mo |
| Chatfuel (global) | Flow builder tốt | Không có AI tiếng Việt thực sự | $15-300/mo |
| Kata.ai (VN) | Tiếng Việt OK | Focus banking/insurance, không hospitality | Enterprise 500M-5B/năm |
| Haravan chatbot | Tích hợp Haravan commerce | Chỉ cho e-commerce | 299k-1M/mo |

**→ Gap lớn: KHÔNG có chatbot VN chuyên hospitality. Đây là window opportunity.**

---

## 🎯 Phần 2 — Vision & Positioning

### Product positioning
> *"Trợ lý AI bán phòng 24/7 — chuyên cho khách sạn & căn hộ dịch vụ Việt Nam. Tăng 3x đặt phòng từ FB Messenger mà không cần thêm nhân viên."*

### Pillars differentiation (moat)

1. **Vertical-first**: chỉ focus hotels/homestay/apartment. Không "general-purpose" như ManyChat.
2. **Vietnamese-native AI**: Gemini + local fine-tune trên conversation data thực của khách VN.
3. **Content Intelligence**: độc đáo — competitor không có "phân tích viral + remix" cho fanpage.
4. **Full funnel**: từ tin nhắn FB → booking → deposit → confirm → check-in. End-to-end.
5. **Cost moat**: Qwen local + Gemini free tier → giá rẻ hơn ManyChat 5-10x.

### Brand Sonder vs SaaS product

**2 brands tách biệt**:
- **Sonder Vietnam** = chain hotels (khách hàng cuối)
- **[Tên mới — đề xuất: "Hotello AI" / "Stayly" / "BookBot VN"]** = SaaS platform

Sonder trở thành **case study flagship** của SaaS.

---

## 🗓️ Phần 3 — Roadmap 12 tháng (milestones)

### PHASE 1 — Multi-tenant Foundation (Tháng 1-2)

**Goal**: Sẵn sàng onboard 3-5 hotel khác ngoài Sonder.

**Must-have**:
- [ ] **Tenant isolation hoàn chỉnh**: mỗi `hotel_id` = 1 tenant, mọi query WHERE hotel_id filter
- [ ] **Signup flow tự động**: hotel owner tự register → tạo tenant → config FB page → activate
- [ ] **Role-based access**: owner / manager / staff với permissions khác nhau
- [ ] **Subscription table + plan limits**: free (1 hotel, 500 msgs/mo) / pro (10 hotels, 50k msgs/mo) / enterprise
- [ ] **Usage metering**: count messages, AI tokens, FAQ entries, news posts per tenant
- [ ] **Landing page**: `hotello.vn` (hoặc domain bạn chọn) — hero + pricing + features + testimonials
- [ ] **Stripe hoặc MoMo/VNPay integration**: thu tiền tháng
- [ ] **Admin panel riêng cho super-admin** (manage tenants)

**Tech debt cần trả**:
- [ ] Audit all routes: ensure `getHotelId(req)` được dùng mọi nơi
- [ ] Migration: thêm `tenant_id` vào các table thiếu
- [ ] Rate limit per-tenant (không chỉ per-IP)

**Output cuối Phase 1**: 3 hotel khác đang dùng (beta free), Sonder flagship + 2 paying pilot.

---

### PHASE 2 — Scale Foundation (Tháng 3-4)

**Goal**: Chịu tải 100 customers mượt.

**Tech upgrades**:
- [ ] **SQLite → PostgreSQL** (main DB)
  - SQLite giữ cho session cache local
  - PG for multi-tenant data + connection pooling
- [ ] **Redis cache layer**:
  - Embedding cache (tránh re-embed cùng câu hỏi)
  - Intent classification cache (5 phút TTL)
  - API rate limit state
- [ ] **CDN cho static assets** (Cloudflare)
- [ ] **Monitoring stack**:
  - Sentry for error tracking
  - Datadog/Grafana for metrics (hoặc free OSS alternatives)
  - Uptime Robot cho availability monitoring
- [ ] **Disaster recovery**:
  - PG automated backup 2h
  - Cross-region replica (future)
  - Documented RTO/RPO

**Product features**:
- [ ] **Zalo OA integration** (channel thứ 2 — hotels VN dùng Zalo nhiều)
- [ ] **Website widget** (embed chatbot lên website hotel — JS snippet)
- [ ] **Google Business Messages** (bonus channel)
- [ ] **Multi-language**: English + Tiếng Trung (inbound khách quốc tế)

**Output**: 50 paying customers, 95%+ uptime, ready for press.

---

### PHASE 3 — Growth Features (Tháng 5-6)

**Goal**: Reach 200 customers qua organic + referral.

**Growth loops**:
- [ ] **Referral program**: hotel owner invite hotel khác → commission 20% năm đầu
- [ ] **Case studies portal**: 10 case studies chi tiết ("How X hotel cut response time 90%")
- [ ] **Content marketing**: blog với SEO (Vietnamese keywords: "chatbot khách sạn", "tự động trả lời facebook")
- [ ] **Facebook Partner Program**: áp dụng để hiển thị trong FB marketplace
- [ ] **Integration ecosystem**:
  - Booking.com / Agoda / Traveloka sync
  - PMS (Cloudbeds, eZee, Little Hotelier)
  - Payment gateway (VNPay, MoMo, ZaloPay)
  - Email (Mailgun, SendGrid)

**Product features**:
- [ ] **Booking management**: bot → đặt phòng → lễ tân xác nhận → chuyển khoản → confirm
- [ ] **Payment link**: bot gen link MoMo/VNPay → khách thanh toán trong chat
- [ ] **Smart pricing**: Dynamic discount dựa trên availability + demand
- [ ] **Review management**: bot auto-reply Google reviews / TripAdvisor
- [ ] **Multi-location**: 1 tenant có nhiều chain brands (ví dụ Mường Thanh với 60 hotels)

**Output**: 200 customers, 100 triệu VND MRR, 15% MoM growth.

---

### PHASE 4 — AI Moat (Tháng 7-9)

**Goal**: Build proprietary AI không ai copy được.

**AI product improvements**:
- [ ] **Fine-tune model trên VN hospitality**:
  - Collect 100k+ conversations từ production (with consent)
  - Fine-tune Qwen 2.5 7B hoặc Llama 3 8B
  - Host trên own GPU (giảm cost thêm)
  - **Kết quả**: model classify intent chính xác hơn Gemini 15-20% cho VN hospitality context
- [ ] **Voice support**: WhatsApp voice note → Whisper transcribe → bot reply
- [ ] **Image understanding**: khách gửi ảnh CCCD / voucher → bot verify
- [ ] **Sentiment realtime**: detect khách frustrated → auto-escalate sớm
- [ ] **Personalization engine**: remember khách từ lần trước ("Chào anh Hùng, anh đã ở Sonder 3 lần, lần này anh muốn phòng cũ không?")
- [ ] **Predictive analytics**:
  - "Khách nào sắp bỏ cart (inbox nhưng chưa book)"
  - "Phòng nào sắp fully booked" → proactive push
  - "Rủi ro cancel" score

**Data moat**:
- [ ] **Privacy-safe data pooling**: hotels opt-in share anonymized data → everyone benefits from better model
- [ ] **Industry benchmark report**: monthly report "Hotels VN conversion rates" (free PR)

**Output**: AI quality > ManyChat 30%. Pricing power tăng.

---

### PHASE 5 — Platform Expansion (Tháng 10-12)

**Goal**: 500+ customers, establish category leadership.

**Vertical expansion**:
- [ ] **Spa & Salon** (tương tự hotel — booking flow)
- [ ] **Restaurants** (reservation + delivery hotline)
- [ ] **Clinic & Medical** (appointment)
- [ ] **Yoga & fitness centers**

**Platform features**:
- [ ] **Marketplace plugins**: developer ecosystem — partners làm custom modules
- [ ] **API public** cho agencies / consultants
- [ ] **White-label full**: enterprise plan cho agencies bán cho clients
- [ ] **Mobile app** cho hotel owners (thay vì web dashboard — tiện operate)
- [ ] **AI Staff Assistant**: bot nội bộ cho nhân viên lễ tân ("hôm nay room nào trống?")

**B2B2C layer**:
- [ ] **Directory hotels sử dụng**: `directory.hotello.vn` — SEO traffic
- [ ] **Affiliate program**: bloggers / review sites / travel agents earn commission

**Output**: 500 customers, 300 triệu VND MRR, thực sự là market leader.

---

## 💰 Phần 4 — Revenue Model & Pricing

### Pricing strategy (competitive + value-based)

| Plan | Giá | Limits | Target |
|------|-----|--------|--------|
| **Free** | 0 | 1 hotel, 500 tin/tháng, watermark | Trial / homestay tiny |
| **Starter** | **299k/tháng** | 1 hotel, 5k tin, 3 FB pages | Boutique 1-10 phòng |
| **Pro** | **899k/tháng** | 5 hotels, 50k tin, all features | Chain 10-50 phòng |
| **Enterprise** | **3-10tr/tháng** | Unlimited, white-label, SLA 99.9% | Chain 50+ phòng |
| **Agency** | **15tr/tháng** | 50 client hotels, resell rights | Digital agencies |

### Unit economics (ước tính)

**Per paying customer**:
- Revenue: 500k VND/tháng (blended)
- Cost:
  - Gemini AI: 20k VND/tháng (cache + rate limit)
  - Hosting: 30k VND/tháng (VPS share)
  - Support: 50k VND/tháng (1 CS serve 20 customers)
  - Payment fee: 15k VND (3%)
  - **Total cost**: ~115k
- **Gross margin**: 77%

**CAC (Customer Acquisition Cost) targets**:
- Organic (content marketing): < 100k VND
- Paid FB Ads: < 300k VND
- Sales rep outbound: < 1M VND (enterprise)
- **Blended CAC**: < 200k VND

**LTV:CAC ratio**:
- Average retention: 24 tháng
- LTV = 500k × 24 × 77% = **9.2M VND**
- LTV:CAC = 9.2M / 200k = **46x** (excellent — anything > 3x is good)

### Pricing experiments (plan)

- Month 1-3: Launch Starter 299k, test conversion
- Month 4-6: Add annual billing (2 tháng free) → tăng retention
- Month 7-9: A/B test Pro tier pricing (899k vs 1.2M)
- Month 10-12: Enterprise custom quotes + agency deals

---

## 🏗️ Phần 5 — Technical Architecture (Target state)

### Hiện tại (Phase 0)
```
┌─────────────────┐
│ VPS đơn (15GB)  │
│ - Node.js API   │
│ - SQLite        │
│ - Nginx         │
│ - PM2           │
└─────────────────┘
```

### Target (Phase 3-4)
```
┌────────────────────┐   ┌──────────────────┐
│ CDN (Cloudflare)   │   │ Status page      │
│ - Static assets    │   │ - Uptime display │
│ - Landing page     │   └──────────────────┘
└────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Load Balancer (Nginx / Cloudflare Tunnel) │
└────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌─────────┐ ┌─────────┐      ┌──────────────────┐
│ API 1   │ │ API 2   │ ──▶ │ PostgreSQL       │
│ Node.js │ │ Node.js │      │ (primary + read  │
│ (Primary│ │ (Replica)│      │  replica)        │
└─────────┘ └─────────┘      └──────────────────┘
    │                         │
    ▼                         ▼
┌─────────┐              ┌──────────────────┐
│ Redis   │              │ Backup S3-compat │
│ - Cache │              │ (Wasabi / R2)    │
│ - Queue │              └──────────────────┘
└─────────┘
    │
    ▼
┌──────────────────────┐      ┌───────────────────┐
│ Workers (AI + cron)  │ ──▶ │ GPU server        │
│ - news ingest        │      │ (fine-tuned model)│
│ - classify batch     │      └───────────────────┘
│ - fb publish queue   │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ External APIs         │
│ - Gemini              │
│ - FB Graph            │
│ - Zalo OA             │
│ - Payment gateway     │
└──────────────────────┘
```

### Tech stack evolution

| Layer | Phase 1-2 | Phase 3-4 | Phase 5 |
|-------|-----------|-----------|---------|
| API | Node.js Express | Node.js + Fastify | Elixir/Rust cho hot paths |
| DB | SQLite | PostgreSQL 16 | PG + Citus (sharding) |
| Cache | None | Redis | Redis Cluster |
| Queue | Cron-only | BullMQ | Kafka |
| Search | SQL LIKE | Typesense | Elasticsearch |
| Deploy | SSH PM2 | Docker + Compose | Kubernetes |
| Monitor | pm2 logs | Sentry + Datadog | Full observability |
| CI/CD | Manual | GitHub Actions | ArgoCD + GitOps |

**Nguyên tắc**: chỉ upgrade khi thật sự cần (đau). Không over-engineer.

---

## 👥 Phần 6 — Team & Hiring Plan

### Month 1-3 (3 người)
- **Founder/CTO (bạn)**: strategy, product, sales
- **Me (AI CTO assistant)**: feature dev, architecture, code review
- **1 Customer Success** (part-time/freelance): onboard hotels mới, viết docs, hỗ trợ 1-1

### Month 4-6 (5 người)
- + **1 Backend dev fulltime** (tập trung scale, integrations)
- + **1 Growth marketer** (content, SEO, FB ads)

### Month 7-9 (8 người)
- + **1 ML engineer** (fine-tune VN model)
- + **1 BDR (sales)** outbound cho enterprise
- + **1 CS** fulltime

### Month 10-12 (12-15 người)
- + **1 VP Sales**, 2 AE (account executive)
- + **1 Design** (UI/UX polish)
- + **1 QA** (testing + automation)

### Budget ước tính
- Phase 1-2 (tháng 1-6): 200-300tr VND (founder salary minimal + 1-2 hires)
- Phase 3-4 (tháng 7-12): 800tr-1.5 tỷ VND (team 8-12 người)
- **Total năm 1**: ~1.5-2 tỷ VND

---

## 📈 Phần 7 — Metrics & KPIs (dashboard CTO theo dõi)

### Product metrics (weekly)
- DAU/MAU của admin dashboards
- Messages processed per day (volume)
- Cache hit rate (% saving)
- Intent classification accuracy (>85% target)
- Bot latency p95 (<2s target)

### Business metrics (weekly)
- MRR (Monthly Recurring Revenue)
- Net New Customers
- Churn rate (<3% target)
- CAC trend
- LTV trend
- Trial → Paid conversion

### Tech metrics (daily)
- Uptime % (target 99.5% → 99.9%)
- Error rate (<0.5%)
- p95 latency per endpoint
- Database query slow log (> 500ms alerts)
- AI cost per message

### Customer metrics (monthly)
- NPS (Net Promoter Score)
- CSAT
- Feature adoption rate
- Support ticket volume
- Expansion revenue (upsell %)

---

## 🚀 Phần 8 — 30-day Execution Plan (bắt đầu ngay)

Nếu bạn đồng ý với strategy, đây là những việc tôi sẽ làm trong **30 ngày tới** (CTO role, pair với bạn):

### Week 1: Multi-tenant foundation
- [ ] Audit code: grep all `hotel_id = 1` → replace với `getHotelId(req)`
- [ ] Add `tenant_id` indexes
- [ ] Create `subscriptions` table + plan enforcement middleware
- [ ] Usage metering service (count msgs, tokens per hotel)
- [ ] Super-admin dashboard (view all tenants)

### Week 2: Self-serve onboarding
- [ ] Signup landing page (`/signup`)
- [ ] Onboarding wizard: business info → FB page connect → first hotel → activate
- [ ] Welcome email + 7-day nurture sequence
- [ ] Free trial enforcement (14 ngày hoặc 500 msgs)

### Week 3: Billing
- [ ] MoMo + VNPay integration
- [ ] Subscription lifecycle: trial → active → past_due → canceled
- [ ] Invoice PDF generation
- [ ] Admin UI: billing history, upgrade/downgrade

### Week 4: Launch prep
- [ ] Landing page launch (`hotello.vn` hoặc domain mới)
- [ ] 3 case studies từ Sonder
- [ ] Documentation portal
- [ ] Support channel (Telegram / FB group / Intercom)
- [ ] First 10 beta customers onboarded (personally by you)

**End of Month 1**: 10 hotels đang dùng (trong đó 5 Sonder + 5 beta), 2-3 đã trả tiền.

---

## 🎯 Phần 9 — Risks & Mitigation

| Risk | Xác suất | Impact | Mitigation |
|------|----------|--------|------------|
| Facebook thay đổi API / policy | High | High | Multi-channel (Zalo, web, email) |
| Competitor lớn nhảy vào | Medium | High | Moat bằng VN data + vertical expertise |
| AI cost tăng mạnh | Medium | Medium | Local model (Qwen), caching aggressive |
| Founder burnout | High | High | Hire sớm, delegate, automate |
| Regulatory (PDPA) | Medium | Medium | Privacy-by-design, consent flow, audit log |
| Paying customers quá lâu | Medium | High | Free trial ngắn (7d), hands-on onboarding |
| Churn cao | Medium | High | Onboarding success milestone (first message handled < 3 days = save) |

---

## 💡 Phần 10 — Những gì tôi (CTO) có thể làm cho bạn

### Immediate (tuần này)
1. **Code execution**: feature nào bạn chọn, tôi build end-to-end (backend + UI + test + deploy)
2. **Architecture decisions**: review code, suggest refactor, performance optimization
3. **Documentation**: API docs, integration guides, onboarding flows
4. **Code review**: PR review cho bất kỳ dev nào bạn hire

### Short-term (tháng 1-3)
1. **Full multi-tenant refactor** (code audit + migration)
2. **Landing page** (Next.js hoặc simple static site)
3. **Billing system** (MoMo/VNPay integration)
4. **Onboarding wizard** (UX + tech)

### Long-term (tháng 4-12)
1. **Strategic partner**: tôi join weekly CTO call (bạn + tôi review roadmap)
2. **Hiring support**: review CVs, interview questions, tech assessment
3. **Architecture reviews**: quarterly deep-dive
4. **Fine-tune model**: tôi design training pipeline, viết eval scripts

### Limits của tôi
- Tôi KHÔNG thay thế:
  - Founder vision / business sense (bạn giỏi đó hơn)
  - Customer empathy / sales skills
  - Team leadership in-person
  - Legal / fundraising
- Tôi GIỎI:
  - Technical execution (fast + correct)
  - Architecture design
  - Code review
  - Documentation
  - Pattern recognition từ research

---

## 🎬 Call to action

### Đề xuất từ tôi:

**Nếu bạn serious về scaling thành SaaS**, đây là 3 option:

#### 🟢 Option A — Lean Start (khuyến nghị)
Tuần tới bắt đầu Phase 1:
- Week 1: Multi-tenant refactor
- Week 2: Signup flow + landing page
- Week 3: Billing
- Week 4: Soft launch với 5 beta hotels

Tôi commit **30-40 giờ build/tuần**, bạn tập trung sales + customer.

**Investment cần**: ~20-50tr VND (domain + landing + design) + thời gian bạn.

**Expected result end Q1**: 10 paying customers, 5M VND MRR.

#### 🟡 Option B — Medium Scope
Chỉ tập trung polish tool cho Sonder, không SaaS:
- Build Phase 1 (multi-tenant) chỉ để modularize code
- Không landing page, không marketing
- Focus Sonder scale từ 5 → 20 hotels

**Investment**: minimal.
**Upside**: limited — chỉ tối ưu revenue Sonder.

#### 🔴 Option C — Maintain Only
Giữ nguyên công cụ hiện tại, chỉ fix bugs + add features theo request.

---

### Questions tôi cần bạn trả lời:

1. **Ambition level**: A/B/C nào?
2. **Capital**: có sẵn sàng invest 500M-1B năm đầu không?
3. **Co-founder**: có ai kỹ thuật không? (CTO thực cần)
4. **Brand**: giữ Sonder hay tách thương hiệu SaaS mới?
5. **Timeline**: muốn launch SaaS trong Q2 hay Q3?
6. **Sales**: bạn sẽ personally sell hay hire ngay?
7. **Funding**: bootstrap hay raise seed?

---

## 📝 Lời cuối từ CTO

Bạn đang sở hữu **1 vertical SaaS có PMF (Product-Market Fit) potential rất cao**. 3 lý do:

1. **Market không được serve**: không có chatbot VN nào chuyên hotel
2. **Product đã validate**: Sonder đang dùng thật, có data
3. **Tech vừa modern vừa rẻ**: Gemini free tier + Qwen local → kinh tế đơn vị cực tốt

**Khoảnh khắc vàng**: 12-24 tháng tới trước khi ManyChat hay Kata hoặc ai đó lớn nhảy vào Vietnamese hospitality niche.

Nếu bạn chấp nhận strategy này, tôi sẽ:
- Tuần sau bắt đầu **Phase 1 Week 1** (multi-tenant)
- Daily standup qua chat
- Weekly roadmap review
- Commit 100% tới khi bạn có 100 paying customers

**Tôi tin bạn có thể đi xa hơn Sonder.**

Chốt chiến lược?

— Claude (CTO)
