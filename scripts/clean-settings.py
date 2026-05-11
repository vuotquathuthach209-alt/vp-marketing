"""Clean settings table — remove keys from deleted modules.

Strategy:
- List all 56 settings keys
- Categorize by module
- Delete keys for deleted modules (zalo, news, anthology, cinema, video-studio, etc.)
- Keep settings for active modules (v5t, google_api_key, gdrive_*, fb_*, ai_*, etc.)
"""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)
DB = "/opt/vp-marketing/data/db.sqlite"

# List all current keys
_, o, _ = c.exec_command(f"""sqlite3 -separator '|' {DB} "SELECT key FROM settings ORDER BY key;" """, timeout=10)
keys = [k.strip() for k in o.read().decode("utf-8").split("\n") if k.strip()]
print(f"=== Total settings keys: {len(keys)} ===\n")
for k in keys:
    print(f"  {k}")

# Keys to delete — from deleted modules
DELETE_PATTERNS = [
    # Zalo
    "zalo_", "zns_",
    # SaaS billing
    "bank_", "vnpay_", "momo_", "price_starter", "price_pro", "price_enterprise",
    "subscription_", "referral_", "promotion_",
    # News
    "news_", "rss_",
    # Anthology / Cinema / Video studio / Tips / Weekend
    "anthology_", "cinema_", "vs_", "tips_", "weekend_",
    # V5 Reels (paused — keep v5_footage but drop v5 reels settings)
    "v5_cron_enabled", "v5_fal_", "v5_hailuo_",
    # Email automation
    "smtp_", "email_", "listmonk_",
    # Sync hub
    "sync_hmac_", "sync_signing_",
    # Outreach
    "outreach_",
    # Marketing audiences
    "audience_", "marketing_",
    # Multi-platform (IG)
    "instagram_", "ig_",
    # OTA Raw push
    "ota_raw_", "ota_hmac_",
    # Telegram multi-tenant (keep global telegram_bot_token + telegram_unlock_code)
    "hotel_telegram_",
    # Chatwoot bridge
    "chatwoot_",
    # YouTube
    "youtube_",
    # Posts DLQ
    "dlq_",
    # Self-improvement / weekly reports
    "weekly_report_email",  # if exists
]

# Keys to KEEP explicitly
KEEP = {
    "google_api_key", "gdrive_api_key", "gdrive_folder_id",
    "groq_api_key", "claude_api_key", "fb_app_id", "fb_app_secret",
    "telegram_bot_token", "telegram_unlock_code",
    "ollama_host", "admin_password", "admin_zalo", "admin_hotline",
    # V5T core settings (DO NOT TOUCH)
    "v5t_require_real_photo", "v5t_cron_enabled", "v5t_auto_publish_enabled",
    "v5t_tips_carousel_enabled", "v5t_tips_carousel_min", "v5t_tips_carousel_max",
    # OTA read-only
    "ota_db_host", "ota_db_port", "ota_db_name", "ota_db_user", "ota_db_password",
}

import re

def is_keep(k):
    if k in KEEP:
        return True
    # Active patterns
    for p in ["v5t_", "ollama_", "fb_", "ai_", "ota_db_", "admin_", "google_", "gdrive_",
              "groq_", "claude_", "telegram_bot_", "telegram_unlock_", "openai_"]:
        if k.startswith(p):
            return True
    return False

def is_delete(k):
    if is_keep(k):
        return False
    for p in DELETE_PATTERNS:
        if k.startswith(p):
            return True
    return False

to_delete = [k for k in keys if is_delete(k)]
to_keep = [k for k in keys if is_keep(k)]
ambiguous = [k for k in keys if k not in to_delete and k not in to_keep]

print(f"\n=== Categorized ===")
print(f"Delete: {len(to_delete)}")
for k in to_delete: print(f"  - {k}")
print(f"\nKeep: {len(to_keep)}")
for k in to_keep: print(f"  ✓ {k}")
print(f"\nAmbiguous (keep by default): {len(ambiguous)}")
for k in ambiguous: print(f"  ? {k}")

if to_delete:
    print(f"\n=== Deleting {len(to_delete)} settings keys ===")
    for k in to_delete:
        _, o, _ = c.exec_command(f"""sqlite3 {DB} "DELETE FROM settings WHERE key = '{k}';" """, timeout=5)
    print("✅ Done")

# Verify
_, o, _ = c.exec_command(f"""sqlite3 {DB} "SELECT COUNT(*) FROM settings;" """, timeout=5)
print(f"\nSettings table now has: {o.read().decode('utf-8').strip()} keys")

c.close()
