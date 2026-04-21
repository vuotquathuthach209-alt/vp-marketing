# Admin Panel — Audit & Improvement Plan
_Ngày audit: 2026-04-21_

## 📊 Hiện trạng (state)

### UI Sidebar — 24 nav buttons, 27 section panels
Tab/panel ordering không match logic flow. Lẫn giữa owner-focused (tạo bài, chấm bot) và admin-focused (intent router, funnel).

### Backend — 25 route files, 1 missing link

### Database — 57 tables, **0 views**
User nói "đã tạo view cho bot" nhưng trên VPS SQLite không có VIEW. Có thể user muốn nói:
- OTA PostgreSQL side (chưa connect — config trống)
- Hoặc chỉ định `hotel_profile` table là "bot knowledge view"

---

## 🐛 Các lỗi + trùng lặp phát hiện

### 1. **4 orphan panels** (có section, không có sidebar button)
| Panel | Có loadX() | Vấn đề |
|-------|------------|--------|
| `monitoring` | ✓ | Không nav được trực tiếp, phải gõ URL/console |
| `onboarding` | ✓ | Chỉ mở khi user vừa register |
| `subscription` | ✓ | Load trigger chỗ khác, không có shortcut sidebar |
| `sysconfig` | ✓ (gọi từ settings tab) | Duplicate với settings |

**Action:** Gom `sysconfig` vào settings panel (nested tabs), thêm sidebar buttons cho `monitoring` + `subscription`. `onboarding` giữ nguyên (auto-trigger).

### 2. **Duplicate knowledge systems** (3 systems song song không đồng bộ!)
| System | Table | Mục đích gốc | Hiện tại |
|--------|-------|--------------|----------|
| A. Wiki AI | `knowledge_wiki` | Admin tự ghi "kiến thức" | Có dữ liệu cho hotel_id=1,2 |
| B. Hotel Knowledge | `hotel_profile` + `hotel_room_catalog` + `hotel_amenities` + `hotel_policies` | AI-synthesized từ OTA scrape | Có cho hotel_id=6,7 |
| C. Learned QA | `learned_qa_cache` | Bot học từ conversation | Auto-populated |
| D. QA Training | `qa_training_cache` | Admin-reviewed QA (Phase 0-4) | 3 approved |

**Vấn đề**:
- **Hotel ID mismatch**: `knowledge_wiki` dùng id 1,2 ; `hotel_profile` dùng 6,7. Không liên kết nhau → bot phải logic riêng cho từng.
- **Không có source-of-truth**: Bot lookup phải check 4 chỗ (wiki → hotel_profile → learned → training) → phức tạp, dễ bỏ sót.
- **Manual sync**: `knowledge_wiki` admin ghi tay, không auto-update khi OTA đổi dữ liệu.

**Action**: Tạo 1 VIEW `v_hotel_bot_context` unify 4 sources, ưu tiên theo thứ tự (trained > hotel_profile > wiki > learned). Tất cả bot queries đi qua view này.

### 3. **Room catalog cực thiếu** (bot không tư vấn được chi tiết phòng!)
```
hotel_profile:       2 hotels (6, 7)
hotel_room_catalog:  1 row only — hotel #7 có 1 phòng, hotel #6 (apartment) có 0 phòng!
```
→ Khi khách hỏi "bên mình có loại phòng nào", bot không có dữ liệu → fallback AI imagine hoặc trả "liên hệ".

**Action**: Force re-sync từ scraper với field mapping đầy đủ (tất cả loại phòng từ web). Script: `src/scripts/reseed-rooms.ts` (sẽ viết).

### 4. **Conflict giữa 2 cache systems** (Q&A)
`learned_qa_cache` (Phase cũ) + `qa_training_cache` (Phase 0-4 mới):
- Cả 2 đều check cache trong `smartReply` nhưng độc lập
- `learned` auto-add mọi QA không qua duyệt
- `training` cần admin approve
- **Bot check cả 2** → 2 lookup embeddings mỗi message = chậm + có thể trả lời trùng

**Action**: Deprecate `learned_qa_cache` → migrate entries sang `qa_training_cache` tier='pending' → admin duyệt dần. Sửa smartReply chỉ dùng 1 cache.

### 5. **Route news_post_drafts bị đè** (Phase N-5 issue đã fix — nhưng còn khác)
Fixed: `/:id` bị catch `/cost-stats`. Nhưng trong `routes/news.ts` có thể còn cases tương tự. Cần audit tương tự.

### 6. **Dead/broken UI fields**
- `hotel_amenities.available` column không tồn tại → nếu code query sẽ fail (code cũ dùng `free` thay vì `available`)
- Các panel `onboarding`, `subscription`, `sysconfig`, `monitoring` có thể dead/không accessed

### 7. **Missing essential admin features**

| Feature | Hiện trạng | Đề xuất |
|---------|-----------|---------|
| **Hotel Editor** (sửa profile, rooms, amenities trực tiếp) | KHÔNG có | Thêm tab mới — scrape chỉ đủ cho 95% cases, admin cần override |
| **OTA DB Config UI** | Trong settings nhưng khó tìm | Wizard setup OTA connection |
| **Bot Playground** (test bot trả lời như khách) | KHÔNG có | Chat test interface trong sidebar → admin thấy bot reply với câu bất kỳ |
| **Content Calendar visual** | `content_calendar` table có nhưng chưa có UI | Calendar view hiển thị bài đăng scheduled + published |
| **Image manager** (pool ảnh Sonder để reuse) | `room_images` table có nhưng thiếu UI quản lý tập trung | Media library kiểu Pinterest |
| **Conversation viewer** | Có `conversation_memory` nhưng không xem được từ admin | Tab "Hội thoại" — xem chat realtime, intervene nếu cần |
| **Analytics deeper** | `loadAnalytics()` có nhưng sơ sài | Thêm biểu đồ theo ngày/tuần, segment theo intent, engagement rate |

### 8. **Prompt quality issues** (content)

- **Angle generator** viết 80-120 từ nhưng đôi khi khô. Prompt không có hook opening mạnh. Sample:
    > "Theo Skift, một số khách sạn trên thế giới đang tiên phong trong việc loại bỏ nhiên liệu hóa thạch..."

    → Không gây tò mò. Thiếu câu hỏi mở đầu / số liệu shocking / emoji.

- **Bot reply** (smartreply) chưa có "voice lock" — mỗi khách sạn có brand voice khác nhau, chưa inject.

- **Sonder spin CTA** cứng 3 biến thể — dễ lặp với người đọc follow nhiều bài.

---

## 🎯 Plan cải thiện — chia 4 đợt ưu tiên

### ĐỢT 1: **Critical fixes** (1 ngày) — phải làm ngay

**1.1. Unify hotel knowledge** 📌 _Ưu tiên cao nhất_
- Tạo view SQLite `v_hotel_bot_context` gộp:
  ```sql
  CREATE VIEW v_hotel_bot_context AS
  SELECT
    hp.hotel_id,
    hp.name_canonical AS name,
    hp.city, hp.district, hp.address,
    hp.product_group, hp.property_type,
    hp.ai_summary_vi, hp.usp_top3,
    hp.monthly_price_from, hp.monthly_price_to,
    hp.min_stay_months, hp.deposit_months,
    hp.full_kitchen, hp.washing_machine, hp.utilities_included,
    json_group_array(DISTINCT json_object(
      'room_key', hrc.room_key,
      'name', hrc.display_name_vi,
      'price_weekday', hrc.price_weekday,
      'price_hourly', hrc.price_hourly,
      'max_guests', hrc.max_guests,
      'bed_config', hrc.bed_config
    )) AS rooms_json,
    ...
  FROM hotel_profile hp
  LEFT JOIN hotel_room_catalog hrc ON hrc.hotel_id = hp.hotel_id
  LEFT JOIN hotel_amenities ha ON ha.hotel_id = hp.hotel_id
  GROUP BY hp.hotel_id;
  ```
- Refactor `hotel-knowledge.ts` `getProfile/getRooms/getAmenities` → đọc từ view.
- Bot flow: 1 query → full context (giảm từ 4 queries xuống 1).

**1.2. Fix knowledge_wiki vs hotel_profile hotel_id mismatch**
- `knowledge_wiki` dùng mkt_hotels.id (1,2)
- `hotel_profile` dùng ota_hotel_id (6,7)
- Thêm column `mkt_hotel_id` vào `hotel_profile` + migrate dữ liệu.

**1.3. Re-seed room catalog đầy đủ**
- Script: quét lại sondervn.com, parse TẤT CẢ room types (không chỉ 1)
- Hiện tại hotel #6 (apartment) có 0 rows trong hotel_room_catalog → fix.

**1.4. Deprecate learned_qa_cache** (hoặc ít nhất tắt lookup song song)
- Sửa smartReply chỉ dùng `qa_training_cache`.
- Migration: copy entries `learned_qa_cache` với hits ≥ 3 sang `qa_training_cache` tier='pending'.

### ĐỢT 2: **Content quality** (2 ngày)

**2.1. Cải thiện news angle generator**
- Thêm "hook types" để rotate:
  - Curiosity: câu hỏi mở ("Anh/chị có nhận thấy...?")
  - Number shock: dẫn số liệu gây chú ý ngay câu đầu
  - Story hook: kể chuyện ngắn về du khách cụ thể
- A/B test 3 hooks → track engagement → chọn top performer.

**2.2. Brand voice per-hotel**
- Thêm column `brand_voice` trong hotel_profile với 3 preset: formal / friendly / luxurious
- Inject vào system prompt của RAG/angle generator: "Hotel X có brand voice [X]. Viết theo giọng điệu này."

**2.3. Smart hashtag system**
- Hiện: 7 hashtags, pick 3 random → hay lặp
- Mới: hashtag bank theo category (location, theme, season) → mix theo context bài viết
- Track impression/engagement mỗi hashtag → ưu tiên top performing

**2.4. Sonder CTA rotation v2**
- Thêm context-aware CTA:
  - Nếu bài về "giá tăng" → "Book sớm ưu đãi 10%"
  - Nếu bài về "hủy phòng" → "Sonder refund linh hoạt"
  - Nếu bài về "trải nghiệm" → "Inbox để được tư vấn chuyên sâu"
- 10-12 biến thể, dynamic selection.

### ĐỢT 3: **Missing features** (3 ngày)

**3.1. Hotel Editor UI**
- Tab mới "Khách sạn" (thay thế hoặc bổ sung knowledge-sync)
- Form edit: name, address, description, USP, amenities, rooms, policies
- Upload ảnh đại diện + ảnh phòng
- Preview bot context trước khi save

**3.2. Bot Playground**
- Tab mới "Test bot" hoặc nested trong Autoreply
- Chat interface: nhập message → bot reply ngay (không qua FB)
- Hiển thị: intent detected, tier used (cache hit vs LLM), latency, cost
- Admin debug tại chỗ.

**3.3. Conversation viewer**
- Tab mới "Hội thoại"
- List active conversations sort by last_message_at
- Click vào → xem full transcript
- Có nút "Can thiệp" → pause bot cho sender này, admin reply tay

**3.4. Content Calendar visual**
- Tab "Lịch" (thay thế hoặc đi kèm campaigns)
- Calendar tháng với dots per day:
  - Red = news post đã/sẽ đăng
  - Blue = manual campaign
  - Green = autopilot
- Drag-drop reschedule

### ĐỢT 4: **OTA DB direct integration** (1 ngày — DEPENDS ON user config)

**4.1. OTA DB connector**
- Setup UI trong Settings:
  - Host, port, database, user, password, SSL toggle
  - Test connection button
- Save → populate settings table

**4.2. Custom view support**
- Nếu OTA có view `v_bot_hotels` hoặc tương tự → support query trực tiếp
- Admin có thể chỉ định view name qua UI
- Bot flow: check view exists → use; else fallback scraper

**4.3. Incremental sync**
- Thay full-sync bằng delta sync (WHERE updated_at > last_sync)
- Sync mỗi 1h thay vì scraper mỗi 6h
- Giảm load OTA DB + dữ liệu tươi hơn

---

## 📋 Quick wins (có thể làm trong 30 phút mỗi cái)

- [ ] Gỡ nav button `funnel` và `intents` nếu chỉ dùng debug (đang có class `nav-admin` — có thể ẩn)
- [ ] Thêm tooltip cho badge pending (hiện chỉ có số, không có text giải thích)
- [ ] Thêm "Ingest ngay" button vào tab Dashboard (không chỉ News tab)
- [ ] Thêm export CSV cho `customer_contacts`, `guest_profiles`
- [ ] Thêm "Copy link bài viết FB" button sau khi publish
- [ ] Add keyboard shortcut: Ctrl+K = search, G+N = news tab, G+T = training tab
- [ ] Dark mode toggle (CSS variable sẵn, chỉ thiếu nút)
- [ ] Admin password strength indicator khi thay đổi
- [ ] Sửa schema bug `hotel_amenities.available` (nếu có query còn dùng)

---

## 🎬 Đề xuất action ngay

### Nếu user muốn **nhanh nhất thấy hiệu quả** (4 giờ):
1. Unify knowledge → v_hotel_bot_context view (Đợt 1.1)
2. Re-seed room catalog (Đợt 1.3)
3. Deprecate learned_qa_cache (Đợt 1.4)
4. A/B hook types cho news angle (Đợt 2.1)
5. Bot Playground (Đợt 3.2)

### Nếu user muốn **chất lượng content cao nhất** (1-2 ngày):
- Đợt 2 toàn bộ + Đợt 3.1 (Hotel Editor)

### Nếu user có **thông tin OTA view**:
- Cần cung cấp: host, port, db name, user, password, SSL, tên view
- Sẽ refactor `ota-db.ts` dùng view thay vì join hotels+rooms

---

## ❓ Câu hỏi cho user

1. **OTA view**: User có thể share credentials + tên view cụ thể? Hiện config trống trên VPS.
2. **Hotel coverage**: Chỉ có 2 hotels scraped (Sonder Airport + Seehome Airport). Có thêm hotels sắp go-live không?
3. **Prompt style**: Có muốn Sonder brand voice riêng biệt (formal / casual / luxury) hay giữ general?
4. **Ưu tiên**: Đợt 1 (fixes) hay Đợt 2 (content quality) hay Đợt 3 (new features) làm trước?
