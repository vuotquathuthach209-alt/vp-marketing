# Admin Module Security & Code Quality Audit — v23 Hardening Sprint

> Generated 2026-04-23 by Explore agent ultra-review.
> 24 issues total: **5 Critical, 8 High, 11 Medium**.

---

## CRITICAL (5)

### 1. `auth.ts:208` — Error disclosure on login
Stack traces + DB error messages leaked in `{ error: 'Lỗi đăng nhập: ' + e.message }`.
**Fix:** Log server-side only, return generic message.

### 2. `outreach.ts:81` — Tenant bleed on GET /:id
`SELECT * FROM scheduled_outreach WHERE id = ?` without `hotel_id` filter → user A reads user B's outreach.
**Fix:** `WHERE id = ? AND hotel_id = ?`.

### 3. `outreach.ts:91` — Tenant bleed on POST /:id/cancel
Same issue — cross-tenant write to cancel other hotels' messages.
**Fix:** include `hotel_id = ?` guard.

### 4. `ocr.ts:56` — SSRF via user-controlled URL
`extractFromUrl(image_url)` has no URL whitelist → admin can hit `localhost`, metadata endpoints, intranet IPs.
**Fix:** Whitelist scheme (https only) + block private CIDR.

### 5. `admin.ts:118` — Dynamic SQL via column interpolation
`UPDATE mkt_hotels SET ${sets.join(', ')}` — enum fields (plan, status) unvalidated.
**Fix:** Whitelist columns + enums before build.

---

## HIGH (8)

| # | File:Line | Problem | Fix |
|---|-----------|---------|-----|
| H1 | content-intel.ts:251 | Dynamic SQL build + unvalidated `scheduled_at` | Hard-coded prepared stmt with NULL for unset |
| H2 | domain-data.ts:169 | `nights`/`guests` no bounds check → negative/huge values | `Math.max(1, Math.min(365, n))` clamp |
| H3 | domain-data.ts:151 | `modifier_value` no type check (NaN, Infinity) | `Number(x)` + range check ±10000 |
| H4 | sync-hub.ts:95 | Negative rooms accepted | Add `>= 0` guard |
| H5 | posts-ops.ts:39 | No pagination on metrics series | User-configurable `limit` clamp |
| H6 | feedback-loop.ts:25 | Missing index `(hotel_id, created_at)` → full scan | CREATE INDEX + fix LIMIT semantic |
| H7 | auth.ts:308 | Signup error leaks `.message` | Generic error |
| H8 | auth.ts:345 | Signin error leaks `.message` | Generic error |

---

## MEDIUM (11)

| # | File:Line | Problem | Fix |
|---|-----------|---------|-----|
| M1 | marketing.ts:107 | DELETE allows `hotel_id = 0` global | Only `hotel_id = ?` owned |
| M2 | attribution.ts:39 | `top-customers` returns across all hotels | Pass `hotelId` into query |
| M3 | admin.ts:21 | Unbounded hotel list + N+1 subqueries | Paginate + materialized count |
| M4 | sync-hub.ts:168 | `!hotelId` fails on NaN | `isNaN` + `<= 0` check |
| M5 | news.ts:70 | `whereSql` built from unvalidated status | Single prepared stmt |
| M6 | self-improvement.ts:88 | DELETE templates no tenant check | Add `hotel_id` filter |
| M7 | auth.ts:254 | Hardcoded defaultFeatures dup | Extract to service |
| M8 | posts.ts:57 | `parseInt` NaN not checked | `isNaN` guard |
| M9 | ocr.ts:78 | Unhandled base64 decode | try-catch |
| M10 | domain-data.ts:81 | PUT allows global, DELETE doesn't | Consistent `hotel_id` policy |
| M11 | marketing.ts:61 | Status enum not validated | Whitelist |

---

## Remediation plan

**Sprint 1 (this push):** All 5 CRITICAL fixes.
**Sprint 2:** All 8 HIGH fixes.
**Sprint 3:** 11 MEDIUM + regression tests.
