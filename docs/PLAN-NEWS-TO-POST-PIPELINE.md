# Plan — News → Travel Angle → Sonder FB Post Pipeline

> Trạng thái: **Draft v1** — chờ user duyệt trước khi build.
> Ngày tạo: 2026-04-20.
> Liên quan: `src/services/campaigns.ts`, `src/services/autopilot.ts`, `src/routes/posts.ts`.

## 🎯 Mục tiêu

Bot tự động:
1. **Hút tin tức thực** từ nguồn uy tín mỗi 2-4 giờ.
2. **Sàng lọc** — chỉ giữ tin ảnh hưởng tới ngành du lịch & lưu trú.
3. **Viết lại** dưới góc độ: *"Sự kiện X tác động đến hành vi đặt phòng/du lịch ra sao"* — trung lập, không chỉ trích.
4. **Gắn brand voice Sonder** — empathetic, forward-looking, CTA nhẹ.
5. **Admin duyệt** trước khi đăng (giống Training Review).
6. **Đăng lên fanpage** 1-2 bài/ngày vào khung giờ vàng.

## 🚫 Ranh giới (bắt buộc)

- **KHÔNG** chỉ trích bất kỳ quốc gia, đảng phái, tôn giáo, cá nhân.
- **KHÔNG** đưa tin chưa kiểm chứng (rumor, forum, social).
- **KHÔNG** clickbait, tiêu đề giật gân.
- **KHÔNG** tuyên bố Sonder có quan điểm chính trị.
- **CHỈ** nói: *"Sự kiện này khiến … du khách chuyển hướng … Sonder tiếp tục hỗ trợ linh hoạt"* — factual + industry insight.
- **CỜ ĐỎ từ khóa cấm** (auto reject): tên chính trị gia, ngôn ngữ phân biệt, tên tôn giáo + xung đột, "đáng trách", "lỗi của", "gây ra bởi".

## 🏗️ Kiến trúc (6 tầng)

```
┌──────────────────────────────────────────────────────┐
│ 1. News Ingest (cron 2h, giới hạn 1 req/s/source)    │
│    RSS + JSON feeds từ whitelist nguồn uy tín        │
│    → raw_articles (source, url_hash, title, body,    │
│                     published_at, lang)              │
└──────────────────────────────────────────────────────┘
                      ↓
┌──────────────────────────────────────────────────────┐
│ 2. Relevance Filter                                   │
│    (a) Keyword gate: "du lịch|hotel|tourism|visa|..."│
│    (b) AI classifier: "travel-industry relevant?"    │
│        → Gemini Flash, JSON {relevant: bool,         │
│          industry_impact: 0-1, angle_hint: string}   │
│    → travel_relevant flag                            │
└──────────────────────────────────────────────────────┘
                      ↓
┌──────────────────────────────────────────────────────┐
│ 3. Angle Generator (Gemini cascade)                   │
│    Prompt ép: "Viết góc nhìn trung lập về tác động   │
│    của [sự kiện] đến hành vi đặt phòng/du lịch.      │
│    KHÔNG chỉ trích. 80-120 từ tiếng Việt."           │
│    → draft_angle                                     │
└──────────────────────────────────────────────────────┘
                      ↓
┌──────────────────────────────────────────────────────┐
│ 4. Sonder Spin (brand voice)                          │
│    Append CTA nhẹ: "Sonder linh hoạt đổi lịch/hỗ     │
│    trợ refund nếu anh/chị cần." + 1 hashtag du lịch  │
│    → draft_post                                      │
└──────────────────────────────────────────────────────┘
                      ↓
┌──────────────────────────────────────────────────────┐
│ 5. Safety Gate (3 lớp) — auto reject nếu fail        │
│    (a) Keyword blocklist (40 từ cấm)                 │
│    (b) Sentiment check: "neutral hoặc positive?"     │
│    (c) Fact-grounded check: "có dẫn nguồn không?"    │
│    → pending_review                                  │
└──────────────────────────────────────────────────────┘
                      ↓
┌──────────────────────────────────────────────────────┐
│ 6. Admin Review + Publish                             │
│    Dashboard tab "News → Post": list pending         │
│    → Duyệt → FB Graph API /feed (có thể gắn ảnh)    │
│    → Scheduled: 7-9am, 12-13h, 20-22h VN time        │
│    → Throttle: max 2/ngày, không trùng topic 3 ngày  │
└──────────────────────────────────────────────────────┘
```

## 📚 Whitelist nguồn tin (uy tín + neutral)

### Quốc tế (English)
| Source | RSS/API | Độ tin cậy | Ghi chú |
|--------|---------|------------|---------|
| Reuters | https://www.reuters.com/rssfeed | AAA | Gold standard, factual |
| AP News | https://apnews.com/hub/travel | AAA | Non-partisan |
| BBC News | http://feeds.bbci.co.uk/news/rss.xml | AAA | UK public broadcaster |
| AFP | https://www.afp.com/en/rss | AAA | French wire service |
| **Skift** | https://skift.com/feed/ | AAA-travel | Best travel-industry insight |
| **WTTC** | https://wttc.org/news | AA-travel | World Travel Tourism Council |
| **UNWTO** | https://www.unwto.org/news | AA-travel | UN body |
| IATA | https://www.iata.org/en/pressroom/ | AA-travel | Aviation data |
| Phocuswire | https://www.phocuswire.com | A-travel | Travel tech |

### Việt Nam
| Source | RSS | Ghi chú |
|--------|-----|---------|
| VnExpress | https://vnexpress.net/rss/du-lich.rss | Mainstream, neutral |
| Tuổi Trẻ | https://tuoitre.vn/rss/du-lich.rss | Mainstream |
| VietnamNet | https://vietnamnet.vn/rss/du-lich.rss | Mainstream |
| Zing News (Znews) | https://znews.vn/du-lich.rss | Trẻ, travel focus |
| VietnamPlus | https://www.vietnamplus.vn/rss | TTX Việt Nam |

### Cấm (low-credibility / partisan)
- Blog cá nhân, diễn đàn, Reddit, Twitter/X (trừ official accounts verified).
- Các site clickbait / tin vịt (list internal).
- Các source không có editorial standards.

## 🔍 Filter logic chi tiết

### Stage 1: Keyword gate (fast, rule-based)
```
TRAVEL_KEYWORDS_VI = [
  'du lịch', 'khách sạn', 'resort', 'homestay', 'nghỉ dưỡng',
  'chuyến bay', 'vé máy bay', 'hủy chuyến', 'hoãn chuyến',
  'visa', 'cửa khẩu', 'xuất cảnh', 'nhập cảnh', 'hộ chiếu',
  'check-in', 'check-out', 'đặt phòng', 'booking', 'refund',
  'mùa lễ', 'tour', 'hướng dẫn viên', 'điểm đến', 'airbnb',
]
TRAVEL_KEYWORDS_EN = [
  'tourism', 'hotel', 'hospitality', 'travel', 'airline',
  'flight', 'cancellation', 'visa', 'border', 'passport',
  'booking', 'occupancy', 'resort', 'destination', 'airbnb',
  'short-term rental', 'homestay', 'tour operator',
]
```
Match ≥ 2 keywords trong title+body → pass stage 1.

### Stage 2: AI relevance classifier
```
prompt:
  system: Bạn phân loại tin tức cho ngành du lịch/khách sạn.
          Trả JSON: {
            relevant: bool,          // có liên quan đến hành vi
                                     // đặt phòng/du lịch không?
            impact: number 0..1,     // mức độ tác động
            region: string,          // khu vực bị ảnh hưởng
            angle_hint: string,      // gợi ý góc nhìn (20 từ)
            political_risk: number,  // 0=an toàn, 1=rất chính trị
          }
  user: [title + first 500 chars of body]

Chỉ pass nếu: relevant=true AND impact >= 0.3 AND political_risk <= 0.4
```
Dùng **Gemini Flash** (free tier, đủ), temp=0.2, JSON mode.

### Stage 3: Dedupe
- Hash URL + canonical title (lowercase, bỏ dấu câu).
- Nếu đã có entry tương tự (cosine ≥ 0.85 với title embedding) trong 7 ngày → skip.

## ✍️ Angle Generator prompt

```
system: Bạn là biên tập viên cho fanpage du lịch. Quy tắc:
  1. TRUNG LẬP. Không chỉ trích bất kỳ ai/tổ chức/quốc gia.
  2. Chỉ nói về TÁC ĐỘNG ĐẾN HÀNH VI DU LỊCH / LƯU TRÚ.
  3. Trích dẫn số liệu nếu có (ví dụ "theo Skift, 32% du khách...").
  4. 80-120 từ, tiếng Việt, thân thiện.
  5. Kết bằng 1 câu hướng về giải pháp linh hoạt.
  6. KHÔNG dùng: "chỉ trích", "đáng trách", "lỗi của", tên đảng
     phái, tôn giáo + xung đột.
  7. Format:
     [Mở bài: sự kiện + nguồn]
     [Tác động: số liệu hoặc xu hướng]
     [Kết: giải pháp ngành / lời khuyên du khách]

user: Tin: "[title]"
      Nội dung: [first 800 chars]
      Góc hint: [angle_hint from classifier]
      Viết bài đăng Facebook theo quy tắc trên.
```

Dùng **Gemini Flash** (primary) qua cascade — fallback Qwen local.
maxTokens: 400, temperature: 0.4 (vừa đủ sáng tạo, vừa kiểm soát).

## 🎨 Sonder Spin layer

Sau angle, append:
```
[draft_angle từ Gemini]

📍 Tại Sonder, nếu lịch trình của anh/chị cần điều chỉnh, đội
ngũ sẵn sàng hỗ trợ đổi ngày hoặc refund linh hoạt nhé ạ 💚

#SonderVN #DuLichLinhHoat #HoTroKhachHang
```

3 biến thể CTA (rotate):
1. "Sonder luôn sẵn sàng hỗ trợ đổi/hủy linh hoạt..."
2. "Nếu chuyến đi cần điều chỉnh, inbox Sonder để được hỗ trợ nhanh..."
3. "Anh/chị cần tư vấn lịch trình thay thế? Sonder tư vấn miễn phí..."

Hashtag rotate: `#SonderVN`, `#DuLich`, `#LuuTru`, `#KhachSan`, `#HoTroLinhHoat`.

## 🛡️ Safety Gate (3 lớp reject)

### Lớp 1: Keyword blocklist
```
BLOCK_TERMS = [
  // Political names
  'donald trump', 'biden', 'putin', 'tập cận bình', 'xi jinping',
  'netanyahu', 'zelensky', 'erdogan', ...,

  // Conflict terms without context
  'chiến tranh là lỗi', 'đáng trách', 'vô đạo đức',
  'phải chịu trách nhiệm', 'thủ phạm',

  // Religious sensitive
  'hồi giáo cực đoan', 'kitô giáo phản động', ...,

  // Discriminatory
  'dân tộc đó', 'bọn chúng', ...,
]
```
Nếu draft match bất kỳ block term → **auto reject** + log.

### Lớp 2: AI sentiment + tone check
```
prompt:
  system: Phân tích draft này. JSON:
    { tone: neutral|positive|negative|aggressive|political,
      has_criticism: bool,
      has_fact_source: bool,
      offensive_score: 0..1 }
  user: [draft_post]

Chỉ pass nếu:
  tone ∈ {neutral, positive}
  has_criticism = false
  offensive_score <= 0.2
```

### Lớp 3: Fact-ground check
Draft phải có ít nhất 1 trong:
- Mention nguồn tin (`theo Reuters`, `theo VnExpress`)
- Số liệu cụ thể (%, USD, số đêm, số khách)
- Timeframe (`trong tháng 3`, `quý này`)

Thiếu → warn admin nhưng không reject (admin có thể edit thêm).

## 💾 Schema DB mới

```sql
CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source TEXT NOT NULL,        -- 'reuters' | 'skift' | 'vnexpress' | ...
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  lang TEXT DEFAULT 'vi',
  -- Classification
  is_travel_relevant INTEGER DEFAULT 0,
  relevance_score REAL DEFAULT 0,
  impact_score REAL DEFAULT 0,
  political_risk REAL DEFAULT 0,
  region TEXT,
  angle_hint TEXT,
  -- State
  status TEXT DEFAULT 'ingested',
    -- ingested | filtered_out | angle_generated | safety_failed
    -- | pending_review | approved | rejected | published
  created_at INTEGER NOT NULL,
  last_state_change_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS news_post_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  hotel_id INTEGER NOT NULL,
  page_id INTEGER,              -- FB page sẽ đăng
  draft_angle TEXT NOT NULL,    -- từ Gemini
  draft_post TEXT NOT NULL,     -- sau Sonder spin
  edited_post TEXT,             -- admin edit
  image_url TEXT,               -- ảnh illustration
  hashtags TEXT,                -- JSON array
  -- Safety
  safety_flags TEXT,            -- JSON { keyword_hits: [], tone: ..., fact_source: bool }
  auto_rejected INTEGER DEFAULT 0,
  rejection_reason TEXT,
  -- Publish
  status TEXT DEFAULT 'pending', -- pending | approved | rejected | published | failed
  scheduled_at INTEGER,
  published_at INTEGER,
  fb_post_id TEXT,
  admin_user_id INTEGER,
  admin_notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (article_id) REFERENCES news_articles(id)
);

CREATE INDEX idx_news_articles_published ON news_articles(published_at DESC);
CREATE INDEX idx_news_articles_status ON news_articles(status);
CREATE INDEX idx_drafts_status_hotel ON news_post_drafts(status, hotel_id);
```

## 📅 Scheduler

- **Cron ingest**: mỗi 2 giờ (6h-24h, skip 0-5h).
- **Cron pipeline**: mỗi 30 phút — xử lý batch 10 articles.
- **Cron publish**: mỗi 15 phút check `status=approved AND scheduled_at<=now()`.
- **Rate limits**:
  - Max 2 bài đăng/fanpage/ngày.
  - Không 2 bài cùng topic trong 3 ngày (topic = `region + keyword_cluster`).
  - Frequency cap: nếu fanpage có engagement giảm 30% → pause auto-news 7 ngày.

## 🖼️ Ảnh (optional, v2)

**Không auto generate image** (rủi ro thương hiệu). Thay vào đó:
- **v1**: đăng text-only (hoặc gắn ảnh từ pool ảnh room Sonder).
- **v2**: cho admin upload ảnh custom khi duyệt.
- **v3**: AI image (Stable Diffusion) chỉ cho topic an toàn (weather, seasonal).

## 🎛️ Admin Dashboard tab mới

```
[tab "News → Post" trong sidebar]

┌─────────────────────────────────────────────────────┐
│ Stats cards:                                         │
│  • Articles 24h  • Filtered in  • Pending drafts    │
│  • Approved 7d   • Published 7d • Rejected 7d       │
└─────────────────────────────────────────────────────┘

Filters: [status: pending] [source: all] [region: all]

List rows:
┌───────────────────────────────────────────────────┐
│ [pending badge] #42 Skift EN → VN                 │
│ ───────────────────────────────────────────────── │
│ 📰 Source: Skift (2h trước) | Region: Asia        │
│    Title: "Japan tourism surges 40% Q1"           │
│    Angle hint: "VN du khách chuyển hướng Nhật"    │
│                                                    │
│ ✍️ Draft:                                          │
│    [Sự kiện + số liệu + Sonder CTA]                │
│                                                    │
│ 🛡️ Safety: tone=neutral, criticism=no,             │
│            fact_source=yes, offensive=0.05         │
│                                                    │
│ [✓ Duyệt & lên lịch] [✎ Sửa] [✗ Từ chối]          │
└───────────────────────────────────────────────────┘
```

Actions:
- **Duyệt & lên lịch**: chọn giờ đăng (gợi ý khung peak) → `status=approved, scheduled_at=...`
- **Sửa**: inline editor cho `edited_post` (và hashtags).
- **Từ chối**: + reason → `status=rejected`.
- **Re-generate angle**: gọi lại Gemini với temperature cao hơn.

## 🔌 Implementation — 5 phases

### Phase N-1: Schema + Ingest (1 ngày)
- [ ] Migration: `news_articles`, `news_post_drafts`, indexes.
- [ ] `src/services/news-ingest.ts`:
  - Parse RSS feeds (dùng `rss-parser` npm).
  - Dedupe by url_hash.
  - Rate limit 1 req/s/source.
- [ ] Cron wire trong `src/services/scheduler.ts`.

### Phase N-2: Filter + Classify (1 ngày)
- [ ] `src/services/news-classifier.ts`:
  - Keyword gate (Vi + En lists).
  - Gemini classifier với JSON output.
  - Update `is_travel_relevant, impact_score, political_risk, region, angle_hint`.
- [ ] Blocklist nguồn (whitelist only).

### Phase N-3: Angle + Sonder Spin (1 ngày)
- [ ] `src/services/news-angle-generator.ts`:
  - Build prompt với rules.
  - Call `smartCascade` (Gemini Flash primary).
  - Store `draft_angle`.
- [ ] `src/services/news-sonder-spin.ts`:
  - Append CTA + hashtags (rotation).
  - Output `draft_post`.

### Phase N-4: Safety Gate + Pending (1 ngày)
- [ ] `src/services/news-safety.ts`:
  - 40-term blocklist (Vi + En).
  - Gemini tone/criticism classifier.
  - Fact-source regex check.
  - Auto-reject if fail; else → pending_review.

### Phase N-5: Admin UI + Publish (2 ngày)
- [ ] `src/routes/news.ts`: CRUD endpoints
  - GET /api/news/stats, /list, /:id
  - POST /:id/approve (with schedule), /reject, /edit
  - POST /:id/regen-angle
- [ ] UI tab "News → Post" (clone pattern từ Training Review).
- [ ] Publish worker `src/services/news-publisher.ts`:
  - Cron 15m check approved + scheduled_at<=now.
  - Call FB Graph API /me/feed.
  - Update fb_post_id + published_at.
  - Retry 3x on failure.

## 💰 Cost estimate (1 hotel, 10 articles/ngày đi vào pipeline)

| Stage | Calls | Token | Gemini Flash cost |
|-------|-------|-------|-------------------|
| Classify (10/day) | 10 | ~200 in / 50 out = 2.5k/day | Free tier đủ |
| Angle gen (pass rate ~40%, 4/day) | 4 | ~800 in / 400 out = 4.8k/day | Free tier đủ |
| Safety (4/day) | 4 | ~400 in / 100 out = 2k/day | Free tier đủ |
| **Total** | **18** | **~9.3k tok/day** | **$0 (within 1500 RPD free)** |

Nếu scale 10 hotels → 180 calls/day, vẫn trong free tier.

## 🎯 KPIs (track sau khi live)

- **Ingest rate**: # articles/day vào pipeline.
- **Pass rate**: % qua tất cả 3 stages (target 20-30%).
- **Approval rate**: % admin duyệt (target 70%).
- **Engagement lift**: likes/comments/shares của auto-post vs manual post.
- **Cost saved**: so với admin tự viết bài từ đầu.

## ⚠️ Rủi ro + mitigation

| Rủi ro | Xác suất | Impact | Mitigation |
|--------|----------|--------|------------|
| Bài đăng bị flag chính trị | Medium | High | 3-layer safety + manual review |
| Nguồn tin fake/rumor | Low | High | Whitelist nghiêm ngặt, no social media |
| AI hallucinate số liệu | Low | Medium | Fact-ground check + admin edit |
| FB spam detection | Low | Medium | Rate limit 2/day, throttle same topic |
| Copyright image | N/A v1 | N/A | Text-only v1, admin upload v2 |
| Reputation nếu sai | Low | High | Fast rollback + page pause kill switch |

## 📝 Next steps

1. User **duyệt plan này** (hoặc sửa points).
2. Chọn **nguồn tin ưu tiên cho v1** (gợi ý: Skift + VnExpress + Tuổi Trẻ).
3. Quyết định **số bài/ngày** (gợi ý: 1 bài/page/ngày cho v1).
4. User cung cấp **pool hashtag Sonder** ưa dùng.
5. Bắt đầu Phase N-1.

---

**Ghi chú**: Plan này **độc lập** với training pipeline. Có thể build song song hoặc sau khi Phase 4 training xong.
