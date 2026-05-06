# 📋 KẾ HOẠCH BÀN GIAO PHIÊN — 2026-05-06

> **MỤC ĐÍCH**: Document đầy đủ tình trạng + plan tiếp theo để anh tự tiếp tục từ máy ở nhà.

> **NGỮ CẢNH**: Pivot toàn diện từ "viral content automation" sang "lưu trú first + tự chủ kỹ thuật". Deploy 5 OSS tools (Authelia + Chatwoot + Listmonk + Umami + Twenty CRM) + email automation pipeline.

---

## 🎯 TÌNH TRẠNG TỔNG QUAN

### ✅ Đã DEPLOY hoàn tất (LIVE production)

| # | Service | URL | Status |
|---|---|---|---|
| 1 | **Authelia** SSO | https://auth.sondervn.com | ✅ LIVE |
| 2 | **Chatwoot** omnichannel inbox | https://chat.sondervn.com | ✅ LIVE |
| 3 | **Listmonk** email | https://mail.sondervn.com | ✅ LIVE |
| 4 | **vp-marketing** dashboard (existing) | https://app.sondervn.com | ✅ LIVE |

### ⏳ Đã DEPLOY container nhưng chờ DNS

| Service | URL | Action cần |
|---|---|---|
| **Umami** analytics | https://analytics.sondervn.com | Anh add DNS A: `analytics` → `103.82.193.74` |
| **Twenty CRM** | https://crm.sondervn.com | Anh add DNS A: `crm` → `103.82.193.74` |

→ DNS watchers ĐANG CHẠY trên VPS, tự certbot + nginx + Authelia gate sau khi DNS resolved (~3 phút).

### ❌ Đã PAUSED (theo skill sonder-tech-sovereignty)

- **V3 Anthology daily** (~$300/tháng) — reach=0, không drive booking → paused
- **Auto-post hard-sell** — bóp page edge rank → paused

### ✅ Vẫn chạy (giữ)

- **V4 Cinema weekly T7** — $7/tháng, brand asset cho website + email
- **Smartreply FB chatbot** — Gemini intent + Ollama Qwen
- **Cron schedulers** — campaign posts, OTA sync, ETL, etc

---

## 🔐 ALL CREDENTIALS (anh save vào Bitwarden)

### Authelia SSO (master gate cho mọi app)
| Field | Value |
|---|---|
| URL | https://auth.sondervn.com |
| Username | `admin` |
| Password | `Sonder@2026SSO!` |
| 2FA | Tắt (sẽ bật khi anh muốn — giờ có Resend SMTP rồi) |

### Chatwoot (omnichannel inbox)
| Field | Value |
|---|---|
| URL | https://chat.sondervn.com |
| Email login | `admin@sondervn.com` |
| Password | `Sonderyz_Us3SYI2U35EMB` |
| API token | `JvHWnJ3QJXN669Qz1qBJAext` |

### Chatwoot Super Admin (rare use)
| Field | Value |
|---|---|
| URL | https://chat.sondervn.com/super_admin |
| Email | `superadmin@sondervn.com` |
| Password | `Sonder12345!@#` |

### Listmonk (email engine)
| Field | Value |
|---|---|
| URL | https://mail.sondervn.com |
| Username | `admin` (CHÚ Ý: username, không phải email) |
| Password | `Sonder@Mail2026!` |

### Resend (SMTP backend)
| Field | Value |
|---|---|
| API key | `re_UURq9rEg_4m12RfSPPzwXSrrykc4EiCWs` |
| Domain | sondervn.com (verified 2026-04-12) |
| Region | ap-northeast-1 (Tokyo) |
| Plan | Free 3000 emails/tháng |

### Umami analytics (sau khi DNS analytics ready)
| Field | Value |
|---|---|
| URL | https://analytics.sondervn.com |
| Default | `admin` / `umami` (đổi NGAY khi vào) |
| Recommend mới | `admin` / `Sonder@Analytics2026!` |

### Twenty CRM (sau khi DNS crm ready)
| Field | Value |
|---|---|
| URL | https://crm.sondervn.com |
| Setup | Form signup khi truy cập lần đầu |
| Recommend | `admin@sondervn.com` / `Sonder@CRM2026!` |

### VPS access
| Field | Value |
|---|---|
| Host | `103.82.193.74` (port 22) |
| User | `root` |
| Password | `cCxEvKZ0J3Ee6NJG` |

⚠️ **TUYỆT ĐỐI**: KHÔNG commit credentials này vào git. File này lưu local, anh paste vào Bitwarden rồi xóa khỏi disk.

---

## 📊 KIẾN TRÚC TỔNG THỂ

```
┌─────────────────────────────────────────────────────────────────┐
│   SONDER VPS 103.82.193.74 (15GB RAM, 8 cores, ~8GB used)       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   AUTHELIA SSO GATE (auth.sondervn.com)                         │
│   1 user → cookie .sondervn.com → mọi *.sondervn.com auth       │
│   Notifier: Resend SMTP (re-enable 2FA capability)              │
│                                                                 │
│   ┌─────────┬─────────┬─────────┬───────────┬───────────┐      │
│   ▼         ▼         ▼         ▼           ▼           ▼      │
│  app.     chat.    mail.   analytics.  crm.       (future)     │
│  sondervn sondervn sondervn  sondervn  sondervn                 │
│   │         │         │          │           │                  │
│   │         │         │          │           │                  │
│  vp-mkt   Chatwoot  Listmonk    Umami       Twenty             │
│  Node.js  + AI bot  + Resend   tracker      CRM                │
│  port     port 3001 SMTP       port 3033    port 3066          │
│  3000                                                           │
│                                                                 │
│   ┌────────────────────────────────────────────────┐           │
│   │  SONDER SMARTREPLY (in vp-marketing)           │           │
│   │  Gemini intent → Ollama Qwen 2.5 (local)      │           │
│   │  Hook: src/services/autoreply.ts              │           │
│   │                                                 │           │
│   │  CHATWOOT BRIDGE (in vp-marketing)             │           │
│   │  Mirror FB messages → Chatwoot inbox UI       │           │
│   │  Routes: src/routes/chatwoot-bridge.ts        │           │
│   │                                                 │           │
│   │  EMAIL AUTOMATION (in vp-marketing)            │           │
│   │  BullMQ → Listmonk API → Resend SMTP          │           │
│   │  Cron: every 15 min poll OTA bookings         │           │
│   │  Templates: 4 (welcome) / 5 (review) / 6 (loyalty) │       │
│   │                                                 │           │
│   └────────────────────────────────────────────────┘           │
│                                                                 │
│   Postgres clusters: chatwoot-db, listmonk-db, umami-db,       │
│                      twenty-db (separate per app)              │
│   Redis: localhost:6379 (for BullMQ vp-marketing)              │
│   Redis: chatwoot-redis (internal Chatwoot)                    │
│   Redis: twenty-redis (internal Twenty)                        │
│   Ollama: 127.0.0.1:11434 (Qwen 2.5-7B local AI)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📋 KHỐI VIỆC TIẾP TỤC (theo thứ tự ưu tiên)

### 🔴 PHASE 4-5 finalize (anh tự làm)

#### Step 1: Add 2 DNS records (5 phút)
Vào trang quản trị domain `sondervn.com`:

```
Type: A,  Name: analytics,  Value: 103.82.193.74,  TTL: 5 phút
Type: A,  Name: crm,        Value: 103.82.193.74,  TTL: 5 phút
```

→ Watchers tự certbot + nginx + Authelia gate trong ~3 phút sau khi DNS propagate.

#### Step 2: Test 2 services public access

**Umami**:
1. Mở https://analytics.sondervn.com
2. Authelia gate → login `admin` / `Sonder@2026SSO!`
3. Umami login → `admin` / `umami` (default)
4. **Đổi password ngay**: Settings → Profile → Change password → `Sonder@Analytics2026!`
5. **Add website**:
   - Click **Add website**
   - Name: `Sonder Vietnam`
   - Domain: `sondervn.com`
6. **Copy tracking script**:
```html
<script async defer src="https://analytics.sondervn.com/script.js"
        data-website-id="<UUID-Umami-generates>"></script>
```
7. **Paste vào sondervn.com** OTA web theme `<head>` — anh tự làm hoặc cấp quyền theme cho dev (em không có quyền OTA).

**Twenty CRM**:
1. Mở https://crm.sondervn.com
2. Authelia gate → login
3. Twenty signup form → tạo workspace:
   - Email: `admin@sondervn.com`
   - Password: `Sonder@CRM2026!`
   - Workspace name: `Sonder Vietnam`
4. Default schema sẽ có: People, Companies, Opportunities — anh có thể dùng tạm.
5. **Custom schema cho hospitality** (nếu muốn): em có thể build sau với scripts (Phase 5C).

### 🟡 PHASE 6+ (em làm khi anh confirm)

#### Phase 6A — Test end-to-end email automation
Tạo 1 booking test trong PMS với email cá nhân anh, đợi 15 phút (cron poll), check inbox xem có nhận email "Welcome" từ Sonder không.

```bash
# SSH vào VPS check
ssh root@103.82.193.74
sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT * FROM email_automation_log ORDER BY id DESC LIMIT 5;"
```

#### Phase 6B — Wire FB messages vào Chatwoot
Hiện tại bridge đã code (Phase 2 commit `24f7aac`) nhưng chưa test thực với guest message. Test:
1. Nhắn FB Sonder Apartment Hotel page từ tài khoản FB cá nhân
2. AI smartreply auto-reply (existing flow)
3. Mở Chatwoot inbox → conversation MỚI xuất hiện, có cả tin guest + reply AI

#### Phase 6C — Re-enable Authelia 2FA
Giờ có Resend SMTP rồi, em có thể bật lại 2FA TOTP:
1. Em sửa `policy: one_factor` → `two_factor` trong `/opt/authelia/config/configuration.yml`
2. Restart Authelia
3. Anh login → Authelia gửi OTP qua email → anh setup TOTP qua app điện thoại

#### Phase 6D — Custom Twenty CRM schema cho hospitality
```typescript
GuestProfile {
  id, name, phone, email, preferred_language
  total_stays: number
  lifetime_value: USD
  preferences: { tea_type, room_floor, breakfast_time }
  tags: ['VIP', 'returning', 'business_traveler']
  source: 'booking.com' | 'agoda' | 'direct' | 'walk_in'
}

Booking {
  guest_id, room_id, dates, source
  attribution_first_touch, attribution_last_touch
  channel_commission_amount
}
```

#### Phase 6E — Sync OTA guests → Twenty CRM
Cron job poll OTA bookings → upsert Twenty People/Companies → enable lifetime guest tracking.

---

## 📁 FILE QUAN TRỌNG TRÊN VPS

| Path | Mục đích |
|---|---|
| `/opt/vp-marketing/.env` | Env vars vp-marketing (Resend, Listmonk, FB, Telegram...) |
| `/opt/authelia/config/configuration.yml` | Authelia SSO config |
| `/opt/authelia/config/users_database.yml` | User accounts (1 admin) |
| `/opt/authelia/.sonder-sso-credentials` | Backup credentials |
| `/opt/chatwoot/.env` | Chatwoot env |
| `/opt/chatwoot/.sonder-credentials` | Chatwoot admin + API token |
| `/opt/listmonk/.env` (in docker-compose) | Listmonk env |
| `/opt/umami/docker-compose.yml` | Umami config |
| `/opt/twenty/docker-compose.yml` | Twenty CRM config |
| `/etc/nginx/sites-enabled/` | Nginx vhost cho mỗi subdomain |
| `/etc/letsencrypt/live/` | SSL certs (auto-renew via certbot cron) |
| `/var/log/sonder-*-deploy.log` | Watcher deploy logs |

---

## 🔄 LỆNH OPS THƯỜNG DÙNG

### SSH vào VPS
```bash
ssh root@103.82.193.74
# password: cCxEvKZ0J3Ee6NJG
```

### Restart 1 service
```bash
# vp-marketing
pm2 restart vp-mkt

# Chatwoot
docker compose -f /opt/chatwoot/docker-compose.yml restart

# Listmonk
docker compose -f /opt/listmonk/docker-compose.yml restart

# Umami
docker compose -f /opt/umami/docker-compose.yml restart

# Twenty CRM
docker compose -f /opt/twenty/docker-compose.yml restart

# Authelia
docker compose -f /opt/authelia/docker-compose.yml restart
```

### Xem log realtime
```bash
pm2 logs vp-mkt --lines 50           # vp-marketing
docker logs -f chatwoot-rails        # Chatwoot
docker logs -f listmonk-app          # Listmonk
docker logs -f umami-app             # Umami
docker logs -f twenty-server         # Twenty
docker logs -f authelia              # Authelia
```

### Health check
```bash
# All containers
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Resource usage
docker stats --no-stream

# Disk
df -h
```

### Email automation health (BullMQ)
```bash
sqlite3 /opt/vp-marketing/data/db.sqlite \
  "SELECT job_name, status, COUNT(*) FROM email_automation_log GROUP BY job_name, status;"

# Redis BullMQ stats
redis-cli -n 1 KEYS 'bull:sonder-email-automation:*' | head -10
```

### Test send email manual
```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer re_UURq9rEg_4m12RfSPPzwXSrrykc4EiCWs" \
  -H "Content-Type: application/json" \
  -d '{"from":"Sonder Vietnam <noreply@sondervn.com>","to":["YOUR_EMAIL"],"subject":"Test","html":"<p>Test</p>"}'
```

---

## 📚 SKILLS LOCKED — Mọi phiên Claude tương lai TUÂN THỦ

| Skill | Path | Mục đích |
|---|---|---|
| `sonder-tech-sovereignty` | `.claude/skills/sonder-tech-sovereignty/SKILL.md` | OSS stack lock + budget cap + ROI threshold |
| `sonder-sso-identity` | `.claude/skills/sonder-sso-identity/SKILL.md` | 1 account principle + Authelia mandate |
| `sonder-storytelling` | `.claude/skills/sonder-storytelling/SKILL.md` | V3 Anthology philosophy (đã pause nhưng giữ skill) |
| `sonder-cinema` | `.claude/skills/sonder-cinema/SKILL.md` | V4 Cinema weekly (giữ active) |
| `sonder-brand-voice` | `.claude/skills/sonder-brand-voice/SKILL.md` | TTS technical pattern |
| `sonder-ecosystem` | `.claude/skills/sonder-ecosystem/SKILL.md` | 4-system architecture context |

→ Khi anh open phiên Claude mới và hỏi về marketing/auth/CRM/email → Claude sẽ tự load skill phù hợp.

---

## 💰 COST RUN-RATE HÀNG THÁNG

```
Software OSS (Authelia + Chatwoot + Listmonk + Umami + Twenty CRM):  $0
VPS (existing):                                                       $0 thêm
Resend (3000 free emails/tháng):                                      $0
AI API (Ollama free + Claude/Gemini fallback):                        $5-15
Cinema weekly Stable Audio:                                            $7
─────────────────────────────────────────────────────────────────────────
TỔNG:                                                                  $12-22/tháng
```

So với SaaS equivalent: Intercom ($1500) + HubSpot ($500) + Mailchimp ($300) + GA4 paid ($150) + Resend ($20) = ~$2470/tháng.

→ **Save $2448-2458/tháng** + tự chủ kỹ thuật 100%.

---

## 🆘 NẾU CÓ SỰ CỐ

### Một service bị lỗi
1. SSH vào VPS
2. Check logs: `docker logs <container-name> --tail 100`
3. Restart: `docker compose -f /opt/<service>/docker-compose.yml restart`

### Mất truy cập Authelia
```bash
# Reset password admin về default
ssh root@103.82.193.74
docker exec authelia authelia crypto hash generate argon2 --password 'NEW_PASSWORD'
# Copy hash output
nano /opt/authelia/config/users_database.yml
# Replace password field với hash mới
docker compose -f /opt/authelia/docker-compose.yml restart authelia
```

### Cookie session lỗi
- Mở incognito browser → login lại
- Hoặc xóa cookie `.sondervn.com` trong browser

### Anh quên link skill (mới mở phiên Claude)
Mở Claude → gõ:
> "Đọc skill sonder-tech-sovereignty và sonder-sso-identity"

Hoặc:
> "Em đang ở phiên cũ rồi đúng không? Em đọc lại docs/SESSION-HANDOFF-2026-05-06.md để tiếp tục"

---

## 📜 GIT HISTORY (commit chính)

```
0aeeccb  feat(phase4-5): deploy Umami analytics + Twenty CRM
94456ea  feat(phase3g): BullMQ + Listmonk email automation triggered by OTA
1bce111  feat(phase3): deploy Listmonk email engine + DNS watcher
24f7aac  feat(chatwoot-bridge): mirror FB conversations to Chatwoot inbox UI
2d29fa9  fix(skills): force-add tech-sovereignty + sso-identity skills
a80a50a  feat(sso): wire Authelia forward auth for chat + app sondervn.com
78ab7b7  feat(sso): central identity provider — Authelia + skill sonder-sso
a071026  feat(strategy): pivot to tech-sovereignty stack — pause Anthology
6abae6f  fix(scheduler): pause hard-sell product-auto-post via setting flag
```

→ Anh có thể `git log` xem chi tiết bất kỳ commit nào.

---

## ✅ CHECKLIST anh resume từ máy nhà

```
[ ] 1. SSH vào VPS test access OK
[ ] 2. Add DNS analytics.sondervn.com → 103.82.193.74
[ ] 3. Add DNS crm.sondervn.com → 103.82.193.74
[ ] 4. Đợi 5-10 phút → check 2 watchers tự xong:
       tail /var/log/sonder-analytics-deploy.log
       tail /var/log/sonder-crm-deploy.log
[ ] 5. Truy cập https://analytics.sondervn.com → setup admin + add tracker
[ ] 6. Truy cập https://crm.sondervn.com → signup workspace
[ ] 7. Save tất cả credentials trong file này vào Bitwarden
[ ] 8. Xóa file này khỏi local (sau khi save credentials)
[ ] 9. Test end-to-end: tạo booking PMS → đợi 15 phút → check inbox welcome email
[ ] 10. Optional: re-enable Authelia 2FA (yêu cầu Claude khi sẵn sàng)
[ ] 11. Optional: paste Umami tracker vào sondervn.com OTA web
```

---

## 📞 KHI MỞ PHIÊN CLAUDE MỚI Ở MÁY NHÀ

Anh chỉ cần:

1. Mở project `tự động đăng facebook` trong Claude Code
2. `git pull origin main` (kéo về tất cả changes mới nhất)
3. Chat:

> "Đọc `docs/SESSION-HANDOFF-2026-05-06.md` để tiếp tục từ phiên trước. Em check status các services + tiếp tục Phase 6A theo plan."

Em (Claude phiên mới) sẽ:
- Load skills sonder-tech-sovereignty + sonder-sso-identity
- Đọc handoff doc
- Check VPS status
- Tiếp tục công việc theo plan

---

**Phiên làm việc**: 2026-05-06 từ ~07:00 - 16:00 ICT
**Tổng thời gian**: ~9 giờ
**Tổng lines code added**: ~3500 (TypeScript + Python scripts + skills)
**Tổng services deployed**: 5 (Authelia, Chatwoot, Listmonk, Umami, Twenty CRM) + Redis + bridge code
**Tổng commits**: 10+ feat/fix
**Skill mới**: 2 (tech-sovereignty + sso-identity)

✅ **Phiên làm việc hôm nay HOÀN TẤT THÀNH CÔNG**.
