# Plan — Smart Intent Training Pipeline

> Hệ thống AI "lãnh đạo thông minh" + "nhân viên địa phương rẻ" + human loop
> Version: 1.1 | Date: 2026-04-20
> 
> ⚠️ **DECISION**: Claude CHỈ dùng cho marketing (caption/post), KHÔNG dùng cho chatbot.
> Smart AI cho training pipeline = **Gemini 2.5 Flash** (free tier) hoặc **Gemini 2.5 Pro** (paid).

---

## 🎯 Mục tiêu

Bot chatbot phải:
1. **Khởi động thông minh**: AI cao cấp (**Gemini 2.5 Flash/Pro**) phân tích ý định khách + sinh reply chất lượng cao
2. **Học dần**: Admin review reply pairs → approved → nạp vào training data
3. **Vận hành kinh tế**: Local AI (Gemma/Qwen) xử lý 80%+ queries (free), chỉ gọi Gemini khi cần thiết
4. **Gate confidence**: Local AI chỉ được phép trả tự động khi match ≥ 70% với data đã train
5. **Tự cải thiện**: Feedback loop — reply tốt được boost, tệ bị demote

**Phân tách AI provider rõ ràng:**

| Use case | AI provider | Lý do |
|----------|-------------|-------|
| **Marketing content** (caption, post Facebook) | **Claude Sonnet 4.5** | Chất lượng Việt cao cấp, brand voice tốt |
| **Chatbot smart reply (bootstrap)** | **Gemini 2.5 Flash** (free) / Pro (paid) | Free tier dồi dào, đủ tốt cho reasoning + VN |
| **Chatbot local reply (steady state)** | **Gemma 2 / Qwen 2.5-7B local** | $0/reply, đủ khi cache hit ≥ 70% |
| **ETL synthesize hotel data** | **Gemini 2.5 Flash** | Đã deploy, work tốt |
| **Embedding (intent matching)** | **MiniLM ONNX local** | Free, instant |

---

## 🏗️ Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│                  Customer Message arrives                    │
└────────────────────────┬────────────────────────────────────┘
                         ↓
              ┌─────────────────────┐
              │  Embedding           │
              │  (MiniLM ONNX local) │
              └──────────┬──────────┘
                         ↓
              ┌─────────────────────┐
              │  Intent Matcher      │
              │  Search QA Cache     │
              │  (cosine similarity) │
              └──────────┬──────────┘
                         ↓
                 ┌───────┴───────┐
                 │               │
           Match ≥ 70%       Match < 70%
                 ↓               ↓
          ┌───────────┐    ┌──────────────┐
          │ Local AI   │    │ Smarter AI   │
          │  (Gemma)   │    │ (Claude)     │
          │  or cached │    │              │
          └─────┬─────┘    └──────┬───────┘
                │                 │
                └────────┬────────┘
                         ↓
                 ┌───────────────┐
                 │  Reply to     │
                 │  customer     │
                 └──────┬────────┘
                         ↓
                 ┌───────────────┐
                 │  Queue Q&A    │  ← tier: pending
                 │  in training  │
                 │  cache        │
                 └──────┬────────┘
                        ↓
              ┌─────────────────────┐
              │  Admin Review       │
              │  Dashboard          │
              └──────────┬──────────┘
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
         Approve              Reject
              ↓                     ↓
         Promote to           Delete / blacklist
         "trusted" tier       (avoid future match)
              ↓
         Available for
         future matching
```

---

## 📦 Components to build

### 1. Database schema (SQLite)

```sql
-- Q&A training cache: center của hệ thống
CREATE TABLE qa_training_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,              -- mkt_hotels.id, scope per tenant
  
  -- Input
  customer_question TEXT NOT NULL,
  question_embedding BLOB,                 -- 384-dim MiniLM
  question_hash TEXT UNIQUE,               -- sha256 để dedupe
  
  -- Output
  ai_response TEXT NOT NULL,
  ai_provider TEXT NOT NULL,               -- 'claude' | 'gemini' | 'gemma' | 'admin_edit'
  ai_model TEXT,                           -- 'claude-sonnet-4-5' | ...
  ai_tokens_used INTEGER,                  -- cost tracking
  
  -- Lifecycle
  tier TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'approved' | 'trusted' | 'rejected' | 'blacklisted'
  admin_notes TEXT,
  admin_edited_response TEXT,              -- if admin edit the reply
  admin_user_id INTEGER,
  approved_at INTEGER,
  
  -- Metrics
  hits_count INTEGER DEFAULT 0,            -- served bao nhiêu lần
  positive_feedback INTEGER DEFAULT 0,     -- customer tiếp tục booking
  negative_feedback INTEGER DEFAULT 0,     -- customer hỏi lại, bỏ đi, complaint
  feedback_score REAL DEFAULT 0,           -- derived metric
  
  -- Context
  intent_category TEXT,                    -- 'pricing' | 'location' | 'booking' | ...
  context_tags TEXT,                       -- JSON array ["rental_type=monthly", "property=apartment"]
  
  -- Timestamps
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER,
  last_reviewed_at INTEGER
);

CREATE INDEX idx_qa_hotel_tier ON qa_training_cache(hotel_id, tier);
CREATE INDEX idx_qa_hash ON qa_training_cache(question_hash);
CREATE INDEX idx_qa_feedback ON qa_training_cache(feedback_score DESC);

-- Feedback tracking
CREATE TABLE qa_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qa_cache_id INTEGER NOT NULL,
  customer_id TEXT,                        -- fb_user_id
  sentiment TEXT,                          -- 'positive' | 'negative' | 'neutral'
  signal TEXT,                             -- 'continued_conversation' | 'asked_again' | 'thumbs_up' | 'thumbs_down' | 'complaint' | 'booking_completed'
  follow_up_message TEXT,                  -- message tiếp theo của customer
  created_at INTEGER NOT NULL,
  FOREIGN KEY (qa_cache_id) REFERENCES qa_training_cache(id) ON DELETE CASCADE
);

CREATE INDEX idx_qa_fb_cache ON qa_feedback(qa_cache_id);
```

### 2. Services mới

#### `intent-matcher.ts`
Core matching service.

```typescript
interface MatchResult {
  matched: boolean;
  confidence: number;          // 0-1, cosine similarity
  qa_cache_id?: number;
  cached_response?: string;
  tier?: 'trusted' | 'approved' | 'pending';
  should_use_cached: boolean;  // true if confidence >= 0.7 AND tier in (trusted, approved)
}

export async function matchIntent(opts: {
  hotelId: number;
  customerMessage: string;
  minConfidence?: number;  // default 0.7
}): Promise<MatchResult>;

export async function saveNewQA(opts: {
  hotelId: number;
  question: string;
  response: string;
  provider: 'claude' | 'gemini' | 'gemma';
  tokens?: number;
  intentCategory?: string;
  contextTags?: string[];
}): Promise<number>;  // returns qa_cache_id

export async function boostQA(qa_cache_id: number): Promise<void>;
export async function demoteQA(qa_cache_id: number): Promise<void>;
```

#### `ai-router-smart.ts`
Routing layer trên router.ts hiện tại.

```typescript
interface SmartReplyResult {
  reply: string;
  source: 'cache' | 'gemini_flash' | 'gemini_pro' | 'gemma' | 'qwen';  // Claude NOT used here
  match_confidence?: number;
  qa_cache_id?: number;
  cost_tokens?: number;
}

export async function smartReplyWithLearning(opts: {
  hotelId: number;
  customerMessage: string;
  context?: string;        // hotel knowledge, history
}): Promise<SmartReplyResult>;
```

Logic:
1. `matchIntent()` trên cache
2. If `match.should_use_cached === true`:
   - Return cached response (Gemma sẽ polish variation nếu cần)
   - Inc `hits_count`
3. Else:
   - Call **Gemini 2.5 Flash** (smart AI cho bootstrap) với hotel context + message
   - Nếu output không đủ tốt → fallback Gemini 2.5 Pro
   - Save response → qa_training_cache với tier='pending'
   - Return response + qa_cache_id (để track feedback)
4. Claude **KHÔNG được gọi từ đây** — chỉ reserved cho marketing tasks (`task='caption'`, `task='image_prompt'`...)

#### `feedback-tracker.ts`
Capture customer follow-up signals.

```typescript
export async function trackFeedback(opts: {
  qa_cache_id: number;
  customerId: string;
  signal: 'continued_conversation' | 'asked_again' | 'complaint' | 'booking_completed';
  followUpMessage?: string;
}): Promise<void>;

// Scheduled job: update feedback_score + auto-demote
export async function recomputeFeedbackScores(): Promise<void>;
```

Signals scoring:
- `booking_completed`: +10
- `continued_conversation` (user reply sau bot): +2
- `thumbs_up` (future UI): +5
- `asked_again` (same question within 5min): -3
- `complaint`: -10
- `thumbs_down`: -5

Auto-demotion:
- `feedback_score < -10` → move to `rejected` tier
- `feedback_score > +20 && hits_count > 10` → promote `approved` → `trusted`

#### `qa-review-service.ts`
Admin API layer.

```typescript
export async function listPendingReviews(opts: { hotelId?: number; limit?: number }): Promise<QAItem[]>;
export async function approveQA(id: number, admin_user_id: number, notes?: string, edited_response?: string): Promise<void>;
export async function rejectQA(id: number, admin_user_id: number, reason: string): Promise<void>;
export async function blacklistQA(id: number): Promise<void>;  // never match again
```

### 3. Admin UI — Tab "Training Review"

New dashboard tab với:
- **List pending** Q&A pairs (paginated)
- Mỗi card hiển thị:
  - 👤 Customer question
  - 🤖 Bot response (AI provider badge)
  - 📊 Confidence used + tokens cost
  - 🕒 Created time
- **Actions** per card:
  - ✅ Approve (as-is)
  - ✏️ Edit & Approve (admin có thể sửa reply trước khi approve)
  - ❌ Reject + reason
  - 🚫 Blacklist (never match this question pattern again)

- **Stats panel**:
  - Total Q&A: X approved, Y pending, Z rejected
  - Confidence distribution histogram
  - Cost saved by caching (tokens avoided)
  - Per-hotel breakdown

### 4. Integration với bot hiện tại

Update `smartreply.dispatchV6`:

```typescript
// Trước khi gọi RAG hay LLM, thử intent-matcher
const match = await matchIntent({ hotelId, customerMessage: msg });

if (match.should_use_cached) {
  // Reply ngay từ cache, no LLM call
  const reply = match.cached_response;
  await trackFeedback({ qa_cache_id: match.qa_cache_id, customerId, signal: 'served_from_cache' });
  return { reply, tier: 'cache' };
}

// Cache miss → fall through to existing pipeline (Gemma local or Claude)
// After LLM reply, save to qa_training_cache
```

---

## 🚀 Implementation phases

### Phase 0: Foundation (1 ngày)
- [ ] Schema migration: `qa_training_cache`, `qa_feedback` tables
- [ ] `intent-matcher.ts`: matchIntent, saveNewQA
- [ ] Integrate Claude API vào `router.ts` as 'reply_smart' task
- [ ] Self-test: fake Q&A → embedding → cosine → match

**Deliverable**: Backend có thể cache Q&A và match intent

### Phase 1: Bootstrap mode (1 ngày)
- [ ] Update dispatchV6: gọi matchIntent trước Gemma
- [ ] Khi cache miss → route to Claude thay Gemma
- [ ] Save mọi Claude reply → qa_training_cache tier='pending'
- [ ] Log provider + tokens cost per reply

**Deliverable**: Bot học Q&A từ mọi customer message, Claude cost ~$5-10/month cho 1000 customers

### Phase 2: Admin Review UI (1 ngày)
- [ ] API routes: /api/admin/qa-review/{list,approve,reject,blacklist}
- [ ] Dashboard tab "Training Review"
- [ ] Pagination, filters, stats panel
- [ ] Approve/Reject actions với admin audit log

**Deliverable**: Admin có thể duyệt Q&A hàng ngày

### Phase 3: Feedback loop (1 ngày)
- [ ] `feedback-tracker.ts` capture signals từ conversation
- [ ] Cron job daily: recompute feedback_score
- [ ] Auto-demote/promote logic
- [ ] Metrics dashboard

**Deliverable**: Hệ thống tự học + tự vệ sinh

### Phase 4: 70% gate + cost optimization (1 ngày)
- [ ] Confidence gate: Gemma chỉ chạy khi match ≥ 70% với approved/trusted
- [ ] Claude only when < 70% AND tier chưa có
- [ ] Retire pending Q&A > 30 ngày không review
- [ ] Weekly performance report

**Deliverable**: Production-ready, cost controlled

---

## 💰 Cost analysis

### Scenario: 1000 messages/ngày — dùng **Gemini 2.5 Flash** (không Claude)

**Month 1 (bootstrap, 100% cache miss)**:
- 100% calls → Gemini 2.5 Flash
- Gemini Flash free tier: **1,500 RPD** — 1000 calls/day fit hoàn toàn
- Cost: **$0/tháng** trong free tier
- Nếu vượt: $0.075/1M input + $0.30/1M output
- 500 tokens in + 200 tokens out × 1000 calls × 30 days = **$2.30/tháng** (paid tier)

**Month 2 (50% cache hit)**:
- 500 cache hits → Gemma local (free)
- 500 Gemini calls → trong free tier luôn
- **Cost: $0/tháng**

**Month 3 (80% cache hit)**:
- 800 cache hits → Gemma local
- 200 Gemini calls → dư free tier
- **Cost: $0/tháng**

### So sánh providers (cho 1000 msgs/day)

| Provider | Month 1 bootstrap | Month 3 steady | Chất lượng VN | Reasoning |
|----------|-------------------|----------------|---------------|-----------|
| **Gemini 2.5 Flash** (FREE tier) | **$0** | **$0** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Gemini 2.5 Flash (paid) | $2 | $0.5 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Gemini 2.5 Pro (paid) | $30 | $6 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| ~~Claude Sonnet 4.5~~ | ~~$135~~ | ~~$30~~ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Reserved cho MKT** |

### Recommended: Gemini Flash tier cascade
```
Match ≥ 85% → Gemma local (free, fastest)
Match 70-85% → Gemma local + log for review
Match < 70% → Gemini 2.5 Flash (free tier)
Match fails (edge case) → Gemini 2.5 Pro (paid, rare)
```

**Dự kiến chi phí cho 1000 hotels × 100 msgs/ngày = 100k msgs/month:**
- Cache hit 80% = 80k served by Gemma ($0)
- Cache miss 20% = 20k served by Gemini Flash
- Free tier: 1,500 RPD × 30 = 45k/month free
- Paid: 20k - 45k = 0 overage = **$0/tháng**

**Conclusion**: Plan này có thể **$0/tháng forever** nếu staying in Gemini free tier. Chỉ cần paid khi vượt 1,500 smart AI calls/ngày.

---

## 📊 Metrics để monitor

1. **Cache hit rate**: % replies served from cache (target 70%+ after month 3)
2. **Admin approval rate**: % pending → approved (target 80%+)
3. **Avg confidence on cached replies**: higher = better quality
4. **Customer satisfaction proxy**:
   - % conversations → booking completed
   - Avg conversation length (short = good, long = bot không rõ)
   - Complaint rate
5. **Cost per reply**: weekly trend
6. **Training data growth**: số approved Q&A per hotel

---

## 🎯 Quyết định quan trọng cần chốt

1. ~~**Smart AI provider**: Claude vs GPT-4 vs Gemini Pro?~~
   - ✅ **CHỐT**: **Gemini 2.5 Flash** (free tier) — Claude reserved cho marketing
   - Nếu query phức tạp cần quality cao hơn: fallback **Gemini 2.5 Pro** (paid)
   
2. **Confidence threshold**: 70% cố định hay adaptive?
   - Đề xuất: **70% cố định** cho MVP, tuning sau khi có data

3. **Admin review workflow**: 
   - Per-hotel admin hay global admin?
   - Đề xuất: **Global admin** cho MVP, sau expand multi-tenant

4. **Retention policy**: giữ rejected Q&A để học hay xóa?
   - Đề xuất: **Soft-delete** (tier='rejected'), giữ để phân tích pattern spam/troll

5. **Edge case**: customer hỏi câu hoàn toàn mới (chưa có pattern tương tự)?
   - Đề xuất: **Gemini 2.5 Pro** handle + flag "bootstrap_urgent" cho admin review sớm

6. **Khi free tier Gemini quota hết** (1500 RPD/project):
   - Option A: Spin up nhiều Google API keys (đã có key rotation trong router.ts)
   - Option B: Fallback Qwen 2.5-7B local (free, slower)
   - Option C: Paid Gemini Flash (~$2-5/tháng)
   - Đề xuất: **Cascade A→B→C**

---

## 🎁 Bonus — Pattern recognition ở admin UI

Admin review nên có feature:
- **Group similar Q&A** (cosine > 0.9) → admin approve 1 lần cho cả nhóm
- **Highlight differences** giữa Q&A tương tự để spot inconsistency
- **Template extraction**: sau nhiều approvals, auto-suggest canonical response

---

## 📅 Timeline tổng

| Phase | Effort | Calendar |
|-------|--------|----------|
| Phase 0 Foundation | 1 ngày | Mon |
| Phase 1 Bootstrap | 1 ngày | Tue |
| Phase 2 Admin UI | 1 ngày | Wed |
| Phase 3 Feedback | 1 ngày | Thu |
| Phase 4 Optimization | 1 ngày | Fri |
| **TOTAL** | **5 ngày** | **1 tuần** |

Sau 1 tuần build + 2-4 tuần bootstrap (admin review), bot vào steady state.

---

## ⚠️ Rủi ro + mitigation

| Rủi ro | Mitigation |
|--------|------------|
| Gemini free tier quota hết | Multi-key rotation (đã có) → Qwen local fallback → paid tier |
| Cost spike (nhiều bootstrap) | Quota monitor + alert khi gần 80% free tier |
| Admin không kịp review | Auto-promote sau 7 ngày nếu hits_count > 20 + no negative feedback |
| Customer hỏi trùng nhau liên tục | Dedupe bằng question_hash, save 1 entry + increment hits |
| Cache poisoning (admin approve reply sai) | Tracking admin_user_id, có thể revert |
| Gemini Flash quality không đủ cho edge case | Escalate Gemini Pro (paid) khi confidence < 50% |

---

## ✅ Success criteria

Sau 1 tháng production:
- [ ] 500+ Q&A pairs approved cho Sonder hotels
- [ ] Cache hit rate ≥ 60%
- [ ] Customer complaint rate giảm 40% vs baseline
- [ ] Cost **$0/month** (stay in Gemini free tier) hoặc < $5/month overage
- [ ] Admin review time < 10 min/day
- [ ] Claude spend KHÔNG tăng (chỉ cho marketing, không cho chatbot)

---

**Bạn cần tôi bắt đầu Phase 0 không?**
Hoặc ưu tiên điều chỉnh gì trong plan?
