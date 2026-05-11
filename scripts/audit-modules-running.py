"""Comprehensive module audit — hit each /api/... endpoint + check DB state.

For each module:
1. Endpoint hit → check 2xx response
2. DB table row count (last 7 days)
3. Recent errors in pm2 log
"""
import paramiko, sys, json

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def sh(cmd, timeout=15):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    return out, err


def sql(q):
    out, _ = sh(f'sqlite3 -separator "|" /opt/vp-marketing/data/db.sqlite "{q}"')
    return out.strip()


print("=" * 70)
print("MODULE AUDIT — VP Marketing")
print("=" * 70)

# ───── 1. ANALYTICS (Reach=0 / Engagement=0 problem) ─────
print("\n\n## 1. ANALYTICS")
print("-" * 50)

# Check post_metrics table
n = sql("SELECT COUNT(*) FROM post_metrics;")
print(f"post_metrics rows: {n}")

n_recent = sql(f"SELECT COUNT(*) FROM post_metrics WHERE last_metrics_at > {int((__import__('time').time() - 30*86400) * 1000)};")
print(f"  last 30 days: {n_recent}")

# Posts table
n_posts = sql("SELECT COUNT(*) FROM posts WHERE created_at > ?;".replace("?", str(int((__import__('time').time() - 30*86400) * 1000))))
print(f"posts last 30 days: {n_posts}")

# Recent posts
print("\nRecent 5 posts (id, status, fb_post_id):")
print(sql("SELECT id, status, fb_post_id, datetime(created_at/1000, 'unixepoch') FROM posts ORDER BY id DESC LIMIT 5;"))

# Pages + access token status
print("\nFB pages:")
print(sql("SELECT id, fb_page_id, name, length(access_token) AS token_len, token_expires_at FROM pages;"))

# Check FB metrics puller log
print("\n--- Recent pm2 metrics-related logs ---")
out, _ = sh("pm2 logs vp-mkt --lines 200 --nostream 2>&1 | grep -iE 'metrics|insights|reach|fb_post' | tail -10")
print(out or "(no metric logs)")

# ───── 2. POSTS (compose, posts, media) ─────
print("\n\n## 2. POSTS")
print("-" * 50)
print(f"posts: total={sql('SELECT COUNT(*) FROM posts;')}")
print(f"  by status: {sql('SELECT status, COUNT(*) FROM posts GROUP BY status;')}")
print(f"media: total={sql('SELECT COUNT(*) FROM media;')}")
out, _ = sh("curl -s http://localhost:3000/api/posts | head -200")
print(f"GET /api/posts (first 200B): {out[:200]}")

# ───── 3. AUTO-REPLY / BOT ─────
print("\n\n## 3. AUTO-REPLY / BOT")
print("-" * 50)
print(f"auto_reply_log: total={sql('SELECT COUNT(*) FROM auto_reply_log;')}")
last24h_ms = int((__import__('time').time() - 86400) * 1000)
print(f"  last 24h: {sql(f'SELECT COUNT(*) FROM auto_reply_log WHERE created_at > {last24h_ms};')}")
print(f"bot_reply_outcomes: total={sql('SELECT COUNT(*) FROM bot_reply_outcomes;')}")
print(f"conversation_memory: {sql('SELECT COUNT(*) FROM conversation_memory;')}")
print(f"intent_logs: {sql('SELECT COUNT(*) FROM intent_logs;')}")

# auto_reply_config
print(f"auto_reply_config: {sql('SELECT page_id, reply_comments, reply_messages FROM auto_reply_config;')}")

# ───── 4. KNOWLEDGE / WIKI ─────
print("\n\n## 4. KNOWLEDGE WIKI")
print("-" * 50)
print(f"knowledge_wiki: total={sql('SELECT COUNT(*) FROM knowledge_wiki;')}")
print(f"hotel_knowledge_embeddings: {sql('SELECT COUNT(*) FROM hotel_knowledge_embeddings;')}")

# ───── 5. HOTEL / AMENITIES / POLICIES ─────
print("\n\n## 5. HOTEL CONFIG")
print("-" * 50)
print(f"hotel_profile: {sql('SELECT id, name, fb_page_id FROM hotel_profile LIMIT 5;')}")
print(f"hotel_amenities: {sql('SELECT COUNT(*) FROM hotel_amenities;')}")
print(f"hotel_policies: {sql('SELECT COUNT(*) FROM hotel_policies;')}")
print(f"hotel_room_catalog: {sql('SELECT COUNT(*) FROM hotel_room_catalog;')}")
print(f"hotel_policy_rules: {sql('SELECT COUNT(*) FROM hotel_policy_rules;')}")
print(f"pricing_rules: {sql('SELECT COUNT(*) FROM pricing_rules;')}")
print(f"promotions: {sql('SELECT COUNT(*) FROM promotions;')}")
print(f"hotel_reviews: {sql('SELECT COUNT(*) FROM hotel_reviews;')}")

# ───── 6. V5T (active!) ─────
print("\n\n## 6. V5T PIPELINE (active)")
print("-" * 50)
print(f"v5_footage total: {sql('SELECT COUNT(*) FROM v5_footage;')}")
print(f"  with vision tags: {sql('SELECT COUNT(*) FROM v5_footage WHERE moment_tag IS NOT NULL;')}")
print(f"v5t_posts: {sql('SELECT COUNT(*) FROM v5t_posts;')}")
print(f"  by status: {sql('SELECT status, COUNT(*) FROM v5t_posts GROUP BY status;')}")
print(f"v5t_post_images: {sql('SELECT COUNT(*) FROM v5t_post_images;')}")

# ───── 7. FUNNEL ─────
print("\n\n## 7. FUNNEL")
print("-" * 50)
print(f"funnel_stage_transitions: {sql('SELECT COUNT(*) FROM funnel_stage_transitions;')}")
print(f"funnel_daily_metrics: {sql('SELECT COUNT(*) FROM funnel_daily_metrics;')}")
print(f"bot_conversation_state: {sql('SELECT COUNT(*) FROM bot_conversation_state;')}")
print(f"bot_booking_drafts: {sql('SELECT COUNT(*) FROM bot_booking_drafts;')}")

# ───── 8. AGENTIC TEMPLATES ─────
print("\n\n## 8. AGENTIC TEMPLATES")
print("-" * 50)
print(f"agentic_templates: {sql('SELECT COUNT(*) FROM agentic_templates;')}")
print(f"agentic_template_suggestions: {sql('SELECT COUNT(*) FROM agentic_template_suggestions;')}")
print(f"agentic_template_selections: {sql('SELECT COUNT(*) FROM agentic_template_selections;')}")

# ───── 9. AUTO POST PRODUCT ─────
print("\n\n## 9. AUTO POST PRODUCT")
print("-" * 50)
print(f"auto_post_plan: {sql('SELECT COUNT(*) FROM auto_post_plan;')}")
print(f"auto_post_history: {sql('SELECT COUNT(*) FROM auto_post_history;')}")
print(f"gdrive_images: {sql('SELECT COUNT(*) FROM gdrive_images;')}")

# ───── 10. CHECK ALL /api endpoints for live response ─────
print("\n\n## 10. LIVE ENDPOINT HEALTH")
print("-" * 50)
endpoints = [
    "/api/health",
    "/api/posts",
    "/api/analytics/summary",
    "/api/analytics/revenue",
    "/api/conversations",
    "/api/wiki/list",
    "/api/knowledge/wiki",
    "/api/funnel/daily",
    "/api/monitoring/bot-health",
    "/api/auto-post/status",
    "/api/auto-reply/config",
    "/api/hotels-editor/profile",
    "/api/onboarding/status",
    "/api/agent/list",
    "/api/agentic-templates",
    "/admin/v5t/inventory",
    "/admin/footage",
    "/api/ota/raw-count",
    "/api/domain/policies",
    "/api/campaigns",
    "/api/retention/policy",
    "/api/ocr/test",
    "/api/admin/me",
    "/api/settings",
    "/api/media",
    "/api/ai/router-status",
]

for ep in endpoints:
    out, _ = sh(f'curl -s -o /dev/null -w "%{{http_code}}" http://localhost:3000{ep}', timeout=8)
    icon = "✅" if out.startswith(("2", "3")) or out in ("401", "403") else "❌"
    print(f"  {icon} {out:>3}  {ep}")

# ───── 11. PM2 errors recent ─────
print("\n\n## 11. RECENT PM2 ERRORS (last 200 lines)")
print("-" * 50)
out, _ = sh("pm2 logs vp-mkt --lines 200 --nostream 2>&1 | grep -iE 'error|fail|throw|cannot|exception|crash' | grep -v 'no error' | tail -25")
print(out or "(no errors)")

c.close()
print("\n\n✅ AUDIT DONE")
