---
name: sonder-sso-identity
description: BẮT BUỘC đọc cho mọi quyết định liên quan đến user authentication, account creation, login system của Sonder. Skill lock NGUYÊN TẮC 1 TÀI KHOẢN duy nhất cho TẤT CẢ apps Sonder (Chatwoot, vp-marketing, Listmonk, Umami, Twenty CRM, future tools). CẤM tạo per-app accounts, CẤM password sprawl. Use khi user hỏi về login, signup, account creation, OAuth, OIDC, SAML, auth, identity provider, password reset, multi-factor authentication, hoặc khi deploy bất kỳ tool mới có authentication. Mọi tool mới PHẢI integrate Authelia BEFORE deploy production.
---

# Sonder SSO & Identity — Single Account Bible

> **MỤC ĐÍCH**: Lock 1-tài-khoản-cho-tất-cả-app principle. Tránh password sprawl. Tự chủ identity provider.

> **CONTEXT TẠO SKILL**: 2026-05-06, sau khi user phàn nàn "dự án này nhiều tài khoản quá" — Chatwoot tạo 2 accounts (admin + super_admin), vp-marketing có account riêng, Listmonk/Umami/Twenty CRM (sắp deploy) sẽ thêm 3-4 accounts nữa nếu không control.

---

## 🎯 NGUYÊN TẮC BẤT BIẾN

```
═══════════════════════════════════════════════════════════════════
  "1 IDENTITY, ALL APPS, ZERO PASSWORD SPRAWL"
═══════════════════════════════════════════════════════════════════

  1. CHỈ 1 USER ACCOUNT cho toàn ecosystem Sonder
     → admin@sondervn.com (single source of truth)

  2. CENTRAL IDP = AUTHELIA (self-hosted, MIT)
     → Mọi app delegate auth tới Authelia
     → Authelia store password + 2FA + sessions

  3. CẤM tạo per-app accounts mới
     → Khi deploy tool mới: integrate Authelia FIRST
     → Internal app users (nếu có) phải mapped tới Authelia identity

  4. SESSION SHARING qua nginx forward auth
     → Login 1 lần ở auth.sondervn.com
     → Truy cập *.sondervn.com auto-authenticated

  5. KHÔNG dùng Google/Microsoft Workspace SSO
     → Vendor lock-in. Use Authelia self-hosted only.

  6. 2FA TOTP — bật khi có SMTP server (Phase 3 Listmonk include SMTP).
     Tạm thời `policy: one_factor` (password only) để tránh blocking
     Authelia OTP registration cần email confirm. Khi SMTP ready
     → switch về `two_factor`.

═══════════════════════════════════════════════════════════════════
```

---

## ❌ ANTI-PATTERNS — KHÔNG được làm

| ❌ KHÔNG | Lý do | ✅ THAY BẰNG |
|---|---|---|
| Tạo admin riêng cho từng app | Password sprawl, quên password | Authelia 1 account → tất cả apps |
| Email + password riêng cho Listmonk | Không tự chủ identity | Authelia OIDC → Listmonk RP |
| Google SSO "Login with Google" | Vendor lock-in Google | Authelia LDAP/local |
| Auth0/Okta/Clerk SaaS | $$$ + dependencies cloud | Authelia self-host MIT |
| Keycloak | Quá nặng (1-2GB RAM Java) | Authelia (50MB Go) |
| Pass token trong query string | Security leak | Authelia cookie session |
| Hardcode admin password trong code | Git leak risk | Authelia DB + .env vars |
| Per-deployment ad-hoc accounts (test, demo) | Forgotten + password sprawl | Disable signup, only Authelia |
| Sharing password qua chat/Slack | Audit trail mất | Authelia user activation flow |

---

## ✅ STACK ĐƯỢC DUYỆT

### **Authelia** (MIT, 22k+ ⭐) — CENTRAL IDP
- Repo: `authelia/authelia`
- Stack: Go + SQLite/Postgres + Redis (optional)
- Resource: ~50MB RAM idle
- Features:
  - Forward auth via nginx `auth_request` (mọi *.sondervn.com)
  - OIDC provider (cho apps support OIDC)
  - 2FA TOTP / WebAuthn
  - User DB: file-based YAML hoặc PostgreSQL
  - Brute force protection
  - LDAP backend (optional)

### Architecture target

```
                  ┌──────────────────────────────────┐
                  │   AUTHELIA (auth.sondervn.com)   │
                  │   ┌──────────────────────────┐   │
                  │   │  User: admin@sondervn.com │   │
                  │   │  Password (Argon2id hash) │   │
                  │   │  2FA TOTP secret          │   │
                  │   │  Sessions                 │   │
                  │   └──────────────────────────┘   │
                  └──────┬─────────────┬─────────────┘
                         │             │
              ┌──────────┘             └──────────┐
              │                                    │
   ┌──────────▼──────────┐              ┌──────────▼──────────┐
   │  Forward Auth flow  │              │  OIDC flow          │
   │  (nginx auth_request│              │  (apps as RP)       │
   │   + Authelia portal)│              │                     │
   └──────────┬──────────┘              └──────────┬──────────┘
              │                                    │
   ┌──────────┴──────────────┐         ┌──────────┴──────────────┐
   │                         │         │                         │
   ▼                         ▼         ▼                         ▼
chat.sondervn.com    app.sondervn.com  Umami                Twenty CRM
(Chatwoot)           (vp-marketing)    (analytics)           (CRM)
                                       Listmonk
                                       (email)
```

### Domain plan

| Subdomain | Purpose | DNS A → |
|---|---|---|
| `auth.sondervn.com` | Authelia portal + login UI | 103.82.193.74 |
| `chat.sondervn.com` | Chatwoot (existing) | 103.82.193.74 |
| `app.sondervn.com` | vp-marketing dashboard | 103.82.193.74 |
| `mail.sondervn.com` | Listmonk (future) | 103.82.193.74 |
| `analytics.sondervn.com` | Umami (future) | 103.82.193.74 |
| `crm.sondervn.com` | Twenty CRM (future) | 103.82.193.74 |

**Tất cả PHẢI có DNS A record + Let's Encrypt cert** trước khi production.

---

## 🔐 ACCOUNT POLICY

### CHỈ 1 USER ACCOUNT trong Authelia (initial)

```yaml
# /opt/authelia/config/users_database.yml
users:
  admin:
    displayname: "Sonder Admin"
    password: "$argon2id$..."  # hash via authelia hash-password
    email: admin@sondervn.com
    groups:
      - admins
```

### Roles (groups) — control access mỗi app

| Group | Access apps | Use case |
|---|---|---|
| `admins` | TẤT CẢ | Owner Sonder (anh) |
| `staff` | Chatwoot + Listmonk | Lễ tân, sale |
| `analytics` | Umami + Twenty CRM | Marketing analyst |
| `dev` | vp-marketing dashboard + super_admin Chatwoot | Developer (em) |

→ Khi cần thêm staff: **TẠO USER trong Authelia**, KHÔNG tạo trong từng app riêng.

---

## 🔄 INTEGRATION PATTERN — Mỗi app

### Pattern A: Forward Auth (đơn giản nhất)
Cho apps không support OIDC native. Nginx `auth_request` → Authelia → pass/fail.

```nginx
location / {
    auth_request /authelia;
    auth_request_set $user $upstream_http_remote_user;
    auth_request_set $groups $upstream_http_remote_groups;

    # Pass to backend with user info as headers
    proxy_set_header X-Forwarded-User $user;
    proxy_set_header X-Forwarded-Groups $groups;
    proxy_pass http://127.0.0.1:3001;
}
```

App (Chatwoot/Listmonk/etc) trust `X-Forwarded-User` header và auto-login user matching email.

### Pattern B: OIDC Native (chuẩn hơn)
Cho apps support OIDC (Umami, Twenty, future Listmonk).

```yaml
# /opt/authelia/config/configuration.yml
identity_providers:
  oidc:
    clients:
      - id: umami
        secret: "$pbkdf2-sha512$..."
        redirect_uris:
          - https://analytics.sondervn.com/oauth/authorize
        scopes: [openid, profile, email]
```

App config:
```env
OIDC_ISSUER_URL=https://auth.sondervn.com
OIDC_CLIENT_ID=umami
OIDC_CLIENT_SECRET=...
```

---

## 🚫 DECISION RULES — Phiên tương lai

Khi user (hoặc AI khác) đề xuất:

1. **Tool mới cần auth** → CHECK skill: integrate Authelia BEFORE deploy
2. **Per-app signup form** → REJECT, chỉ 1 admin trong Authelia
3. **"Login with Google/GitHub" SaaS button** → REJECT, vendor lock-in
4. **Keycloak / Auth0 / Okta / Clerk / WorkOS** → REJECT (cost + lock-in)
5. **Tạo demo/test account riêng trong app** → REJECT, dùng Authelia user "test" với group hạn chế
6. **Disable Authelia for "convenience"** → REJECT, security baseline
7. **Embed admin credentials trong code/docker** → REJECT, dùng env vars + .env (chmod 600)

---

## 📋 IMPLEMENTATION CHECKLIST (mới deploy)

- [ ] Phase A: Deploy Authelia container (Docker compose)
- [ ] Phase B: Configure single user (admin@sondervn.com) + 2FA TOTP
- [ ] Phase C: Setup nginx forward auth for chat.sondervn.com
- [ ] Phase D: Setup nginx forward auth for app.sondervn.com
- [ ] Phase E: Test SSO flow — login Authelia → access both apps
- [ ] Phase F: Document admin password recovery process
- [ ] Phase G: Setup TOTP backup codes
- [ ] Phase H: Future apps (Listmonk/Umami/Twenty) integrate via OIDC

---

## 🔧 OPS RUNBOOK

### Reset admin password
```bash
ssh root@103.82.193.74
cd /opt/authelia
docker compose exec authelia authelia hash-password 'NEW_PASSWORD'
# Copy output hash to config/users_database.yml
docker compose restart authelia
```

### Add new staff user
```bash
# Edit config/users_database.yml
# Add new user with desired groups
docker compose restart authelia
```

### Disable user (offboarding)
```bash
# Edit config/users_database.yml — set disabled: true
docker compose restart authelia
```

### Recover lost 2FA
```bash
# SSH VPS
sqlite3 /opt/authelia/data/db.sqlite3 "DELETE FROM totp_configurations WHERE username='admin';"
# Login again — Authelia prompts to setup TOTP again
```

---

## 💰 COST IMPACT

| Item | Before SSO | After SSO |
|---|---|---|
| Number of accounts | 1 per app × 5 apps = **5+ accounts** | **1 account** |
| Password storage | 5 different passwords scattered | 1 in Authelia (Argon2id) |
| Onboarding new staff | Create 5 accounts manually | Add 1 row in users.yml |
| Offboarding | Delete 5 accounts (often forgotten) | 1 row update |
| 2FA | Per-app (most apps don't support) | Authelia central 2FA |
| Audit trail | Scattered | Central Authelia logs |
| Password sprawl risk | HIGH (post-it notes, recycled) | ZERO |

**ROI**: Reduce ops overhead + improve security posture. Zero $ tăng (Authelia free MIT).

---

## 🛡 SECURITY BASELINE

- Authelia config file: `chmod 600`
- Authelia data dir: `chmod 700`
- TOTP MUST be enabled cho admin user
- Backup TOTP codes lưu trong password manager (Bitwarden/KeePass)
- Cookie domain: `.sondervn.com` (subdomain sharing)
- Cookie HttpOnly + Secure + SameSite=Lax
- Session timeout: 1 hour idle, 8 hour absolute
- Brute force: 5 attempts → 5 min lockout
- HTTPS only (HSTS preload)

---

## 📚 LINKED SKILLS

- `sonder-tech-sovereignty` — Master OSS stack (Authelia is part of it)
- `sonder-ecosystem` — 4-system architecture context

---

## 🚨 CRITICAL REMINDERS cho Claude tương lai

1. **KHI USER NÓI "tạo admin cho [app]"** → check Authelia first, không tạo riêng trong app
2. **KHI DEPLOY tool mới** → setup OIDC/forward auth FIRST, không deploy plain auth
3. **KHI THẤY signup form bật** → DISABLE ngay (`ENABLE_ACCOUNT_SIGNUP=false`)
4. **KHI USER QUÊN PASSWORD** → reset qua Authelia hash-password, không bypass app auth
5. **KHI TÍCH HỢP SaaS thứ 3** → reject, chỉ accept tools support OIDC self-host
6. **KHI USER MUỐN NHIỀU NGƯỜI dùng** → add user trong Authelia với group, không tạo per-app
7. **KHI TEST SCENARIO** → dùng Authelia "test" user trong dev group, không hardcode credentials

---

**LAST UPDATED**: 2026-05-06
**OWNER**: Sonder Identity & Security
**TRIGGER COUNT**: ALL authentication-related decisions
**REVIEW CYCLE**: 90 ngày — verify accounts list, rotate Authelia secret, audit groups
