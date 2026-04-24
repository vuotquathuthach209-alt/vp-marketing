# Vector Embeddings Plan — Semantic Layer v26

> **Phase 2 (sau khi product-auto-post v25 stable).** Em propose architecture
> trước, ship sau. Implementation ~2 ngày work.

## 🧠 Vector dùng cho gì (3 use cases)

### 1. **Semantic Hotel Matching** — hiểu ý khách sâu hơn
```
Khách: "Tôi cần chỗ yên tĩnh, tránh ồn, làm việc remote"
                        ↓
Bot query → embedding 768d
                        ↓
Search hotel_embeddings
                        ↓
Return top 3: hotels có description gần nghĩa nhất
  (VD: "view công viên", "tầng cao ít tiếng xe",
       "wifi 100Mbps", "bàn làm việc riêng")
```

**Hiện tại**: bot chỉ match keyword (location, budget, # guests). Keyword search bỏ lỡ khách nói dạng natural language.

**Với vector**: bot hiểu ý nghĩa — "yên tĩnh" match cả "thư giãn", "xa trung tâm", "không ồn ào", "quiet".

### 2. **Content Gen Contextual** — caption có chiều sâu hơn
```
Product auto-post picker chọn hotel X
                        ↓
Search vector: "hotel X có gì ĐẶC BIỆT so với network?"
                        ↓
LLM nhận context: "unique USPs vs compete"
                        ↓
Caption nhắn đúng điểm nổi bật riêng của X, không copy-paste template
```

**Hiện tại**: caption hotel X có thể giống hotel Y nếu cùng angle.

**Với vector**: mỗi hotel có unique fingerprint → caption highlight đúng thứ khác biệt.

### 3. **Image Dedup Visual** (thay URL fingerprint primitive)
```
Image URL khác nhau nhưng cùng ảnh (CDN variants, resize)
                ↓
Perceptual hash (pHash) / CLIP embedding
                ↓
Search image_embeddings: cosine similarity > 0.95 → dedup
```

**Hiện tại**: em dedup by URL hash → 2 URLs khác nhau của cùng ảnh vẫn bị post 2 lần.

**Với vector**: visual similarity detection → skip ảnh gần-giống.

## 🏗 Architecture

### Tables mới

```sql
-- Text embeddings (hotel descriptions, reviews, content)
CREATE TABLE vector_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,       -- 'hotel' | 'room' | 'review' | 'post' | 'caption'
  entity_id INTEGER NOT NULL,
  text_hash TEXT,                  -- MD5 of input text (dedup)
  vector BLOB NOT NULL,            -- Float32Array (768 dims)
  model TEXT NOT NULL,             -- 'minilm-l6-v2' | 'gemini-embedding' | ...
  dims INTEGER NOT NULL DEFAULT 768,
  metadata_json TEXT,              -- extra filters (property_type, city, price_range)
  created_at INTEGER NOT NULL,
  UNIQUE(entity_type, entity_id, model)
);
CREATE INDEX idx_vec_entity ON vector_embeddings(entity_type, entity_id);
CREATE INDEX idx_vec_hash ON vector_embeddings(text_hash);

-- Image embeddings (pHash-based, compact)
CREATE TABLE image_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_url TEXT NOT NULL,
  phash TEXT NOT NULL,             -- 64-bit perceptual hash hex
  clip_vector BLOB,                -- Optional CLIP 512d for semantic image search
  hotel_id INTEGER,
  resolution_w INTEGER,
  resolution_h INTEGER,
  brightness REAL,                 -- 0-1 (for quality filter)
  computed_at INTEGER NOT NULL,
  UNIQUE(image_url)
);
CREATE INDEX idx_img_phash ON image_embeddings(phash);
CREATE INDEX idx_img_hotel ON image_embeddings(hotel_id);
```

### Models

| Model | Dim | Speed | Use case |
|-------|-----|-------|----------|
| `all-MiniLM-L6-v2` (local ONNX) | 384 | fast | Hotel descriptions, queries |
| `gemini-embedding-001` (API) | 768 | slow, needs key | High-quality content embeddings |
| `openai-text-embedding-3-small` (API) | 1536 | slow | Production backup |
| Perceptual hash (sharp/jimp) | 64-bit | fast | Image dedup (no AI) |
| CLIP ViT-B/32 (optional) | 512 | medium | Semantic image search |

Em propose **MiniLM local** cho hotels (đã có onnx package sẵn trong codebase via intent-matcher), **pHash** cho images (lightweight, no AI needed).

### Flow mới cho product-auto-post

```
Cron 6h: sync OTA hotels (existing v25)
            ↓
Cron 6:30h: compute missing embeddings
  - For each hotel: vectorize description → hotel_embeddings
  - For each image: compute pHash → image_embeddings
            ↓
Cron 7h: generate plan
  Step 1: picker (scoring) — MORE
  Step 1.5: NEW — "Find distinctive aspects"
    - Get target hotel embedding
    - Find 3 nearest hotels (semantic)
    - Caption generator gets context: "Unlike X, Y, Z hotels, this hotel's edge is..."
  Step 2: image picker — DIFFERENT
    - Still pick from OTA
    - NEW: reject if pHash similar to recent posts (> 0.95 cosine)
  Step 3-4: angle + caption (enhanced with semantic context)
```

## 📈 Business value

| Scenario | Không vector | Với vector |
|----------|-------------|------------|
| "Phòng yên tĩnh cho work remote" | Bot hỏi: area? budget? | Bot gợi 2 hotel cụ thể match ý |
| Caption auto-gen | Template giống nhau | Highlight USP distinctive |
| Image dedup | URL khác = ảnh khác | Visual same = dedup |
| Search knowledge base | Keyword match | Natural language |
| Customer segment | Manual tag | Auto-cluster theo persona |

## 🚀 Rollout plan (3 phases)

**Phase A** (1 ngày): Hotel text embeddings
- Schema + migration
- `vectorize-hotels.ts`: on-demand compute + cache
- Integrate vào picker step 1.5 (semantic distinctive)

**Phase B** (1 ngày): Image pHash
- Install `sharp` or `jimp` (perceptual hash)
- Compute pHash for all OTA images + cache
- Update image-picker dedup

**Phase C** (1 ngày, optional): CLIP embeddings
- Semantic image search
- Caption + image coherence check

Total: **3 ngày work**. Em recommend ship Phase A trước, đo impact engagement rồi quyết Phase B/C.

## ❓ Em cần anh/chị confirm

- Bot MKT VPS có 15GB RAM / 8 cores — đủ chạy MiniLM 384d local (đã chạy intent-matcher tương tự)
- pHash không cần AI, chỉ cần install `sharp` (~40MB native deps) — OK?
- CLIP heavier, có thể skip nếu không cần visual search

---

**Em đề xuất**: ship v25 stable trong 1 tuần, đo baseline engagement, rồi v26 vector add value đo lường được. Không overbuild.

Nếu anh/chị muốn làm ngay, em ship Phase A trong 1 ngày tới. Báo em quyết định nhé.
