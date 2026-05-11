"""Drop empty DB tables from deleted modules.

ONLY drops tables that are:
1. Empty (0 rows) on production
2. Created by a module that has been deleted from code

DOES NOT touch tables that have data, OR tables referenced by current code.
"""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

# Tables to DROP — must be empty AND from a deleted module
TABLES_TO_DROP = [
    # SaaS billing (phase 1)
    "subscription_requests", "payments", "referral_codes", "referral_commissions", "promotion_usage",
    # Zalo (phase 2)
    "zalo_articles", "zalo_zns_log", "zalo_zns_templates", "zalo_oa",
    # Telegram multi-tenant + Chatwoot + Email (phase 3)
    "telegram_chats", "hotel_telegram_config", "chatwoot_bridge_mappings",
    "email_automation_log", "email_log",
    # OTA Raw push (phase 4)
    "ota_raw_availability", "ota_raw_images", "ota_raw_rooms", "ota_raw_hotels", "ota_raw_batches",
    # News pipeline (phase 5) — empty? check first
    # "news_articles", "news_post_drafts",  # ← these HAVE data, do NOT drop
    # V2-V4 video (phase 6)
    "tips_videos", "tips_ideas", "tips_hook_experiments",
    "weekend_videos", "weekend_theme_log",
    "story_series", "story_episodes", "story_characters", "story_locations", "story_arcs",
    "anthology_characters", "anthology_locations", "anthology_values", "anthology_logos",
    "anthology_arcs", "anthology_arc_episodes", "anthology_continuity",
    "cinema_series", "cinema_episodes", "cinema_shots", "cinema_costs_log",
    "video_projects", "video_scenes", "video_brand_kits", "video_content_ideas",
    "video_publish_log", "video_series", "video_cost_ledger", "video_stock_cache",
    # V5 Reels  (phase 7) — keep v5_footage (V5T uses it!) but drop v5 reels-specific tables
    "v5_scripts", "v5_rendered_clips", "v5_ab_results",
    # SaaS CRM (phase 7)
    "marketing_audiences", "audience_memberships", "broadcast_campaigns", "broadcast_sends",
    "attribution_links", "revenue_events", "customer_ltv",
    "scheduled_outreach", "outreach_rate_log",
    "instagram_accounts", "page_crosspost_links", "share_packages",
    # Sync hub (phase 8)
    "sync_outbox", "sync_webhook_inbound", "sync_conflicts",
    "sync_api_keys", "sync_events_log", "sync_availability", "sync_bookings",
    "mkt_availability_cache", "mkt_bookings_cache", "mkt_rooms_cache", "mkt_permissions",
    # Misc dead (phase 8-9)
    "failed_posts_dlq", "appointments",
    "auto_post_image_blacklist",  # may exist, dead
    "conversation_labels",
    "data_deletion_requests",
    "monthly_learnings", "prompt_lessons",
    "property_types_discovered",
    "agent_tool_calls",  # check
    "agentic_opening_cache",
    "agentic_template_variants", "agentic_variant_winner_log",
    "bot_feedback",
    "billing_reminder_log",
    "qa_feedback",
    "ai_cache",
    "mkt_hotels_cache",
    "ab_experiments",
    "etl_hotel_failures",
    "etl_sync_log",
    "ota_raw_pricing",  # if exists
    "ota_raw_amenities",
    "ota_raw_policies",
    "ota_raw_promotions",
    "post_metrics_old",  # if any
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)

DB = "/opt/vp-marketing/data/db.sqlite"

# First, backup DB
print("=== Backing up DB ===")
_, o, _ = c.exec_command(f"cp {DB} {DB}.cleanup-bak-$(date +%s) && ls -la {DB}*", timeout=30)
print(o.read().decode("utf-8"))

# Step 1: list all tables that EXIST in our drop list
print("\n=== Verifying which target tables exist + are empty ===")

dropped = []
skipped_nonexistent = []
skipped_nonempty = []
errors = []

for t in TABLES_TO_DROP:
    # Check exists
    _, o, _ = c.exec_command(
        f"""sqlite3 {DB} "SELECT name FROM sqlite_master WHERE type='table' AND name='{t}';" """,
        timeout=10
    )
    if not o.read().decode("utf-8").strip():
        skipped_nonexistent.append(t)
        continue

    # Check empty
    _, o, _ = c.exec_command(f"""sqlite3 {DB} "SELECT COUNT(*) FROM {t};" """, timeout=10)
    try:
        n = int(o.read().decode("utf-8").strip())
    except:
        n = -1

    if n != 0:
        skipped_nonempty.append((t, n))
        continue

    # Drop it
    _, o, e = c.exec_command(f"""sqlite3 {DB} "DROP TABLE {t};" """, timeout=10)
    err = e.read().decode("utf-8").strip()
    if err:
        errors.append((t, err))
    else:
        dropped.append(t)

print(f"\n✅ Dropped {len(dropped)} empty tables:")
for t in dropped:
    print(f"  - {t}")

print(f"\n⏭️  Skipped {len(skipped_nonempty)} tables (have data — NOT dropped):")
for t, n in skipped_nonempty:
    print(f"  - {t} ({n} rows)")

print(f"\n📭 Already absent (not in DB): {len(skipped_nonexistent)}")
for t in skipped_nonexistent[:20]:
    print(f"  - {t}")
if len(skipped_nonexistent) > 20:
    print(f"  ... and {len(skipped_nonexistent) - 20} more")

if errors:
    print(f"\n❌ Errors:")
    for t, err in errors:
        print(f"  - {t}: {err}")

# Show table count before/after
_, o, _ = c.exec_command(
    f"""sqlite3 {DB} "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" """,
    timeout=10
)
print(f"\n=== Total tables remaining: {o.read().decode('utf-8').strip()}")

# Also VACUUM to reclaim space
print("\n=== VACUUM ===")
_, o, _ = c.exec_command(f"ls -la {DB}", timeout=10)
print("Before:", o.read().decode("utf-8").strip())
_, o, _ = c.exec_command(f"""sqlite3 {DB} "VACUUM;" && ls -la {DB}""", timeout=60)
print("After: ", o.read().decode("utf-8").strip())

c.close()
print("\n✅ DB cleanup DONE")
