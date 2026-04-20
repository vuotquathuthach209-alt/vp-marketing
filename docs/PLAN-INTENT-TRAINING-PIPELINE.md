# Plan — Smart Intent Training Pipeline

> Hệ thống AI "lãnh đạo thông minh" + "nhân viên địa phương rẻ" + human loop
> Version: 1.0 | Date: 2026-04-20

---

## 🎯 Mục tiêu

Bot chatbot phải:
1. **Khởi động thông minh**: AI cao cấp (Claude/GPT-4) phân tích ý định khách + sinh reply chất lượng cao
2. **Học dần**: Admin review reply pairs → approved → nạp vào training data
3. **Vận hành kinh tế**: Local AI (Gemma) xử lý 80%+ queries (free), chỉ gọi Claude khi cần thiết
4. **Gate confidence**: Local AI chỉ được phép trả tự động khi match ≥ 70% với data đã train
5. **Tự cải thiện**: Feedback loop — reply tốt được boost, tệ bị demote

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
  source: 'cache' | 'claude' | 'gemini' | 'gemma';
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
   - Return cached response
   - Inc `hits_count`
3. Else:
   - Call **Claude** (smart AI) với hotel context + message
   - Save response → qa_training_cache với tier='pending'
   - Return response + qa_cache_id (để track feedback)

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

### Scenario: 1000 messages/ngày

**Month 1 (bootstrap)**:
- 100% calls hit Claude (cache trống)
- Claude Sonnet 4.5: ~$3/1M input, $15/1M output
- Avg 500 tokens in + 200 tokens out per call
- 1000 calls/day × 30 days × ($3×500/1M + $15×200/1M) = $135/month
- Admin review → accumulate Q&A

**Month 2 (50% cache hit)**:
- 500 calls hit cache (Gemma free)
- 500 calls Claude = $67/month
- Cost saved: $68/month

**Month 3 (80% cache hit)**:
- 800 cache hits
- 200 Claude = $27/month
- **Steady state**: ~$30/month for 1000 msgs/day quality bot

### Alternative: Skip Claude, use Gemini Flash
- Gemini 2.5 Flash: $0.075/1M input, $0.30/1M output
- Cheaper but lower quality reasoning
- **Month 1**: 1000×30×($0.075×500/1M + $0.30×200/1M) = $4/month
- **Good option** nếu budget căng

### Recommended: Hybrid
- Claude for intents chưa match (bootstrap + edge cases)
- Gemini Flash cho bulk replies khi cache hit moderate
- Gemma local cho match ≥ 85%

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

1. **Smart AI provider**: Claude vs GPT-4 vs Gemini Pro?
   - Đề xuất: **Claude Sonnet 4.5** — tốt tiếng Việt, JSON structured output reliable
   
2. **Confidence threshold**: 70% cố định hay adaptive?
   - Đề xuất: 70% cố định cho MVP, tuning sau

3. **Admin review workflow**: 
   - Per-hotel admin hay global admin?
   - Đề xuất: **Global admin** cho MVP (1 người review tất), sau expand multi-tenant

4. **Retention policy**: giữ rejected Q&A để học hay xóa?
   - Đề xuất: Soft-delete (tier='rejected'), giữ để phân tích pattern spam/troll

5. **Edge case**: customer hỏi câu hoàn toàn mới (chưa có pattern tương tự)?
   - Đề xuất: Claude handle + flag "bootstrap_urgent" cho admin review sớm

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
| Claude API down | Fallback Gemini → Gemma local cascade |
| Cost spike (nhiều bootstrap) | Hard cap $X/month, alert khi gần ngưỡng |
| Admin không kịp review | Auto-promote sau 7 ngày nếu hits_count > 20 + no negative feedback |
| Customer hỏi trùng nhau liên tục | Dedupe bằng question_hash, save 1 entry + increment hits |
| Cache poisoning (admin approve reply sai) | Tracking admin_user_id, có thể revert |

---

## ✅ Success criteria

Sau 1 tháng production:
- [ ] 500+ Q&A pairs approved cho Sonder hotels
- [ ] Cache hit rate ≥ 60%
- [ ] Customer complaint rate giảm 40% vs baseline
- [ ] Cost < $50/month cho 1000 customers/day
- [ ] Admin review time < 10 min/day

---

**Bạn cần tôi bắt đầu Phase 0 không?**
Hoặc ưu tiên điều chỉnh gì trong plan?
