# Admin Sidebar — Information Architecture Redesign

> v24 • April 2026 • Addresses 25-item flat menu chaos reported by user.

## Problem statement

Sidebar trước đây có 25+ items xếp phẳng trong 1 group "Tự động":

- Scroll dài → khó tìm
- Không có mental model → user phải đọc từng label
- Overlap chức năng (3 phễu khác nhau, 6 mục "bot")
- Naming bất nhất (VN/EN trộn)
- **Bug thật**: `data-tab="funnel"` bị duplicate ở 2 button (line 99 "Sales Funnel" + line 114 "Funnel (admin)") → 2 panel cùng hiện

## Design principles

1. **Miller's Law**: mỗi group ≤ 7 items (có thể ±2)
2. **Mental model theo job-to-be-done**: user suy nghĩ theo nhiệm vụ, không theo feature
3. **Progressive disclosure**: collapsible groups, mở cái nào user cần
4. **Persistence**: remember user's collapse state trong `localStorage`
5. **Role-based**: admin-only items gom 1 group có visual indicator 🔒
6. **Zero breaking change**: giữ nguyên tất cả `data-tab` values → không đụng backend

## New IA — 6 groups + Dashboard + Settings

```
▸ Tổng quan (always visible)

▾ Báo cáo & hiệu suất (3)
  • Thống kê
  • Hiệu suất bot          (rename "Bot Monitor")
  • Doanh thu & Phễu       (rename "Revenue & Funnel")

▾ Nội dung & Bài đăng (6)
  • Tạo bài
  • Autopilot
  • Danh sách bài          (rename "Danh sách")
  • Thư viện media         (rename "Media")
  • News → Post
  • Ảnh phòng

▾ Chatbot & AI (8)
  • Cài đặt chatbot        (rename "Chatbot")
  • Hội thoại
  • Thử bot
  • Chấm bot
  • AI Agent
  • Kiến thức AI
  • Duyệt training
  • Tạm dừng bot

▾ Bán hàng & Khách (5)
  • Sales Funnel
  • Chiến dịch
  • Khách quen
  • Giới thiệu
  • Lịch hẹn

▾ Khách sạn & Kênh (4)
  • Khách sạn
  • OTA DB
  • OTA Pipeline
  • Kênh liên lạc

▾ Nâng cao 🔒 (admin only, 4)
  • Content Intel
  • Intent Router
  • Knowledge Sync
  • Funnel (raw)           (renamed from "Funnel (admin)")

▸ Cài đặt (always visible, bottom)
```

**Total**: 1 + 3+6+8+5+4+4 + 1 = **32 visible** (vs 28 trước) nhưng chia làm 6 group, user scan từng group. Nhờ collapsible → mặc định chỉ hiện group đầu.

## Grouping rationale

| Group | Tại sao items này thuộc cùng group |
|-------|-------------------------------------|
| **Báo cáo & hiệu suất** | Tất cả là "đọc số đang chạy" — không tạo / không sửa |
| **Nội dung & Bài đăng** | Tất cả là pipeline tạo-sản-xuất-phân-phối FB/IG post |
| **Chatbot & AI** | Tất cả liên quan việc bot trả lời khách — config, observe, intervene, train |
| **Bán hàng & Khách** | Conversion funnel + CRM — từ lead → booking → returning customer |
| **Khách sạn & Kênh** | Data sources — hotel profile, OTA integration, messaging channels |
| **Nâng cao** | Developer/admin tools — tuning, low-level analytics, system observability |

## Bug fix: duplicate `data-tab="funnel"`

**Trước:**

```html
<!-- Line 99 -->
<button data-tab="funnel">Sales Funnel</button>
<!-- Line 114 -->
<button data-tab="funnel">Funnel (admin)</button>

<!-- Line 1145 -->
<section data-panel="funnel">Sales Funnel content</section>
<!-- Line 2403 -->
<section data-panel="funnel">Growth Funnel (admin) content</section>
```

Cả 2 button đều mở `data-panel="funnel"` → cả 2 panel hiện đồng thời.

**Sau:**

```html
<button data-tab="funnel">Sales Funnel</button>
<button data-tab="funnel-admin">Funnel (raw)</button>

<section data-panel="funnel">Sales Funnel</section>
<section data-panel="funnel-admin">Growth Funnel (raw)</section>
```

Tab switcher thêm: `if (tab === 'funnel-admin') loadFunnelAnalytics()`.

## Collapsible behavior

```js
// State persisted in localStorage as array of collapsed group IDs
// e.g. ["advanced", "ota"] → those 2 groups collapsed
const NAV_STATE_KEY = 'vp-nav-collapsed-groups';

// When user clicks a tab inside a collapsed group → auto-expand.
// Ensures user never loses sight of "which group am I in".
```

## Badge propagation

Khi group bị collapse, nếu bất kỳ child button nào có badge active (e.g., `news-badge` hiện pending news count) → group header hiện dot màu amber để user biết có việc cần attention.

CSS: `.nav-group.has-badge .nav-group-header::after` = 6px amber dot với glow.

Polling refresh 30s (cùng cadence với existing `pollBadges`).

## Accessibility

- Header là `<button>` semantic — keyboard navigable
- Aria attributes (có thể bổ sung sau): `aria-expanded`, `aria-controls`
- Focus ring preserved từ Tailwind defaults

## Zero-downtime migration

- Tất cả `data-tab` values giữ nguyên (VD: `autoreply`, `wiki`, `contentintel`...)
- Các handler `switchTab()` không cần sửa trừ thêm 1 dòng cho `funnel-admin`
- Backend hoàn toàn không biết về thay đổi này

## Before vs After — khi user mở dashboard lần đầu

**Trước:**
- 1 item "Tổng quan" + 4 items "Nội dung" + **25 items "Tự động"** + 1 item "Báo cáo" + 1 item "Quản lý"
- User phải scroll

**Sau:**
- 1 item "Tổng quan" + 6 group collapsible (tất cả default mở) + 1 item "Cài đặt"
- Group đầu tiên "Báo cáo & hiệu suất" chỉ có 3 items → user nhanh chóng thấy được overview
- Scroll chỉ khi tương tác với Chatbot group (lớn nhất, 8 items)
- Collapse group không dùng → next session mở chỉ 3-4 group đang dùng

## Future improvements (sprint 3)

1. **Command palette** (⌘K) để search nhanh tab — thay thế scroll hoàn toàn
2. **Customizable sidebar** — user tự reorder / pin favorite tabs
3. **Contextual badges** — group header hiện count, không chỉ dot
4. **Breadcrumbs trong topbar** — "Chatbot & AI › Cài đặt chatbot"
5. **Hotkey navigation** — `g d` = dashboard, `g c` = chatbot, tương tự Linear/GitHub
