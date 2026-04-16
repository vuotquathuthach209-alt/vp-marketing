# VP-MARKETING MULTI-TENANT PLAN
# Luu ngay: 2026-04-16
# Nguyen tac: OTA DB READ-ONLY, khong sua/ghi gi len OTA

## PHASE 1: Foundation (Tuan 1-2)

### Tuan 1: Multi-tenant DB + OTA Sync
- [x] Ket noi Google Cloud DB read-only (ota-db.ts - da xong)
- [x] 1.1 MKT DB schema moi: them hotel_id vao TAT CA tables hien tai
  - pages: them hotel_id
  - posts: them hotel_id  
  - campaigns: them hotel_id
  - auto_reply_config: them hotel_id
  - auto_reply_log: them hotel_id
  - knowledge_wiki: them hotel_id
  - ai_usage_log: them hotel_id
  - ab_experiments: them hotel_id
  - pending_bookings: them hotel_id
  - telegram_chats: them hotel_id
  - hotel_telegram_config: giu nguyen (da co page_id)
- [x] 1.2 Bang moi: mkt_hotels (hotel_id, ota_hotel_id, plan, status, config)
- [x] 1.3 Bang moi: mkt_permissions (hotel_id, feature, enabled)
- [x] 1.4 Bang moi: mkt_users (id, ota_email, hotel_id, role, last_login)
- [x] 1.5 Migration script: data Sonder hien tai gan hotel_id = 1
- [x] 1.6 Data Sync Cache: cron 6h sync hotels/rooms tu OTA -> mkt_hotels_cache, mkt_rooms_cache

### Tuan 2: Auth + Admin + Isolation
- [x] 2.1 Auth moi: login bang email OTA (verify qua OTA DB read-only, KHONG ghi)
  - POST /api/auth/login { email, password }
  - Query OTA: SELECT id, email, password_hash, hotel_id FROM hotel_owners/customers
  - Verify password local (bcrypt compare)
  - Check mkt_permissions -> co quyen hay khong
  - Tra JWT voi { userId, hotelId, role }
- [x] 2.2 Middleware: extractHotelId tu JWT, inject vao moi request
- [x] 2.3 Admin panel: /admin route (super admin only)
  - List tat ca hotels tu OTA
  - Mo/dong quyen MKT cho tung hotel
  - Chon plan: free / starter / pro
  - Xem usage stats per hotel
- [x] 2.4 Hotel isolation: sua TAT CA routes them WHERE hotel_id = ?
  - pages, posts, campaigns, autoreply, wiki, analytics, booking, autopilot
- [x] 2.5 Auto-provision: khi admin mo quyen -> tu dong tao:
  - wiki entries tu OTA hotel data
  - default auto_reply_config
  - default booking config tu OTA room_types + pricing
- [x] 2.6 Test: 2 hotel khac nhau, data tach biet hoan toan

## PHASE 2: Multi-hotel Engine (Tuan 3-4)

### Tuan 3:
- [x] Autopilot per hotel: schedule, pillars, topics rieng (autopilot.ts rewrite)
- [x] Smart Reply per hotel: wiki buildContext() now accepts hotelId
- [x] Content template engine: hotel-specific context from OTA cache
- [x] Rate limiting per hotel (plan-based: checkRateLimit in autopilot.ts)

### Tuan 4:
- [x] FB Page management per hotel (settings.ts pages WHERE hotel_id)
- [x] Booking flow per hotel: getPendingBookings(hotelId)
- [x] Auto-sync room pricing tu OTA -> autoGenWikiFromOta (ota-sync.ts)
- [x] Rate limiting per hotel (max_posts_per_day in mkt_hotels)
- [x] All routes hotel_id isolated: posts, campaigns, media, wiki, autoreply, autopilot, booking

## PHASE 3: Pilot 5 KS (Tuan 5-6)
- [ ] Invite 5 KS doi tac
- [x] Onboarding: ket noi FB Page + Telegram (onboarding.ts — 7 endpoints + UI)
- [x] Monitor: AI costs, response time, error rate (monitoring.ts — 4 endpoints + UI dashboard)
- [ ] Thu feedback, fix top 5 bugs
- [x] Optimize: AI response cache (ai-cache.ts), template reuse, auto cleanup 3h

## PHASE 4: Launch & Scale (Tuan 7-8)
- [x] Pricing page / Subscription management (subscription.ts — plans, current, upgrade, confirm)
- [x] Subscription UI (3 plans: free/starter/pro with usage tracking)
- [x] Payment integration (VNPay/MoMo/Bank transfer — payment.ts full flow)
- [x] Auto-provision khi hotel upgrade plan (confirm-payment auto-enables features)
- [x] Email campaign (nodemailer, bulk invite, single invite, templates)
- [x] Alerting system (error rate, AI cost spike, hourly check cron)
- [x] Admin: email log, payments management, confirm bank transfer UI
- [ ] Target: 30 KS dang ky, 10 paid
- [ ] Scale server (production deployment)

## OTA DB SCHEMA (READ-ONLY, khong sua)
- hotels: id, name, slug, address, city, star_rating, phone, check_in_time, check_out_time, amenities, status, owner_id
- hotel_owners: id, full_name, email, phone, password_hash, status
- room_types: id, hotel_id, name, base_price, hourly_price, max_guests, bed_type, amenities, status
- rooms: id, hotel_id, room_type_id, room_number, floor, status, housekeeping_status
- room_availability: id, hotel_id, room_id, date, price, status, booking_id
- bookings: id, booking_code, hotel_id, room_id, room_type_id, guest_id, checkin_date, checkout_date, nights, total_price, payment_status, booking_status
- guests: id, hotel_id, customer_id, full_name, email, phone
- customers: id, email, phone, full_name, password_hash, loyalty_tier
- pricing_rules: id, hotel_id, name, rule_type, conditions, adjustment_type, adjustment_value, is_active
- coupons: id, hotel_id, code, discount_type, discount_value, is_active, valid_from, valid_to

## NGUYEN TAC BAT BUOC
1. OTA DB chi doc, KHONG BAO GIO ghi/sua/xoa
2. Moi data MKT luu trong MKT DB rieng
3. Auth verify qua OTA DB nhung KHONG ghi session vao OTA
4. hotel_id isolation: moi query phai co WHERE hotel_id = ?
5. Super admin (ban) co the xem tat ca hotels
6. Per-hotel Telegram bot da co san (hotel-telegram.ts)
