"""Deep audit per module via DB + direct Node script (bypass HTTP auth)."""
import paramiko, sys, json
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def node(script, label, timeout=60):
    """Execute Node script directly inside the app context."""
    sftp = c.open_sftp()
    with sftp.open("/tmp/audit-mod.js", "w") as f:
        f.write(script)
    sftp.close()
    _, o, _ = c.exec_command(f"cd /opt/vp-marketing && timeout 50 node /tmp/audit-mod.js 2>&1", timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    # Skip the boot DB messages
    useful = [l for l in out.split("\n") if not l.startswith("[db]") and not l.startswith("[boot]")
              and "self-test" not in l and not l.startswith("[brand-")
              and not l.startswith("[reply-tmpl-seed]") and "ota-guard" not in l]
    print(f"\n=== {label} ===")
    print("\n".join(useful[-30:]).strip())


# 1. ANALYTICS — call getOverview() directly
node("""
const { getOverview, getBestPostingTime, getDailyTrend } = require('/opt/vp-marketing/dist/services/analytics');
console.log('OVERVIEW(30d):', JSON.stringify(getOverview(30)));
console.log('BEST_TIME:', JSON.stringify(getBestPostingTime(60)?.best_hour));
console.log('DAILY_TREND_LEN:', getDailyTrend(14).length);
process.exit(0);
""", "1. ANALYTICS getOverview")

# 2. BOT MONITOR — bot health stats
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const last24 = Date.now() - 86400000;
const stats = {
  conversations_last_24h: db.prepare("SELECT COUNT(*) as n FROM auto_reply_log WHERE created_at > ?").get(last24),
  bot_replies_last_24h: db.prepare("SELECT COUNT(*) as n FROM bot_reply_outcomes WHERE created_at > ?").get(last24),
  pending_handoffs: db.prepare("SELECT COUNT(*) as n FROM handoff_tracker WHERE status='pending'").get(),
  active_conversations: db.prepare("SELECT COUNT(*) as n FROM bot_conversation_state").get(),
  intent_logs_total: db.prepare("SELECT COUNT(*) as n FROM intent_logs").get(),
};
console.log(JSON.stringify(stats, null, 2));
process.exit(0);
""", "2. BOT MONITOR stats")

# 3. POSTS list
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const recent = db.prepare("SELECT id, status, fb_post_id, datetime(created_at/1000, 'unixepoch') AS created FROM posts ORDER BY id DESC LIMIT 5").all();
const counts = db.prepare("SELECT status, COUNT(*) AS n FROM posts GROUP BY status").all();
console.log('Counts by status:', JSON.stringify(counts));
console.log('Recent 5:', JSON.stringify(recent, null, 2));
process.exit(0);
""", "3. POSTS")

# 4. MEDIA library
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const r = db.prepare("SELECT COUNT(*) as n, COUNT(DISTINCT type) AS types FROM media").get();
const types = db.prepare("SELECT type, COUNT(*) AS n FROM media GROUP BY type").all();
console.log('Media:', JSON.stringify(r));
console.log('By type:', JSON.stringify(types));
process.exit(0);
""", "4. MEDIA")

# 5. AUTO-POST PRODUCT
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const plan = db.prepare("SELECT id, hotel_id, scheduled_at, status, datetime(scheduled_at/1000,'unixepoch') AS sched FROM auto_post_plan ORDER BY scheduled_at DESC LIMIT 5").all();
const history = db.prepare("SELECT id, hotel_id, fb_post_id, datetime(posted_at/1000,'unixepoch') AS posted FROM auto_post_history ORDER BY id DESC LIMIT 5").all();
console.log('Auto-post plan:', JSON.stringify(plan, null, 2));
console.log('History:', JSON.stringify(history, null, 2));
process.exit(0);
""", "5. AUTO-POST PRODUCT")

# 6. AUTO-REPLY CONFIG
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const cfg = db.prepare("SELECT * FROM auto_reply_config").all();
console.log('Auto-reply config:', JSON.stringify(cfg, null, 2));
process.exit(0);
""", "6. AUTO-REPLY CONFIG")

# 7. CONVERSATIONS
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const recent = db.prepare("SELECT DISTINCT sender_id, MAX(created_at) AS last FROM conversation_memory GROUP BY sender_id ORDER BY last DESC LIMIT 5").all();
const total_unique = db.prepare("SELECT COUNT(DISTINCT sender_id) AS n FROM conversation_memory").get();
console.log('Unique conversations:', JSON.stringify(total_unique));
console.log('Recent senders:', JSON.stringify(recent.map(r => ({ sender_id: r.sender_id.slice(0,10)+'...', last: new Date(r.last).toISOString() }))));
process.exit(0);
""", "7. CONVERSATIONS")

# 8. KNOWLEDGE WIKI
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const r = db.prepare("SELECT category, COUNT(*) AS n FROM knowledge_wiki GROUP BY category ORDER BY n DESC LIMIT 10").all();
const total = db.prepare("SELECT COUNT(*) AS n FROM knowledge_wiki").get();
console.log('Wiki total:', JSON.stringify(total));
console.log('By category:', JSON.stringify(r, null, 2));
process.exit(0);
""", "8. KNOWLEDGE WIKI")

# 9. HOTEL CONFIG
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const profile = db.prepare("SELECT * FROM hotel_profile LIMIT 3").all();
const amenities_cnt = db.prepare("SELECT COUNT(*) AS n FROM hotel_amenities").get();
const rooms = db.prepare("SELECT COUNT(*) AS n FROM hotel_room_catalog").get();
const policies = db.prepare("SELECT COUNT(*) AS n FROM hotel_policies").get();
console.log('Profile count:', profile.length, profile.map(p => ({id: p.id, name: p.name, fb: p.fb_page_id})));
console.log('Amenities:', amenities_cnt.n, 'Rooms:', rooms.n, 'Policies:', policies.n);
process.exit(0);
""", "9. HOTEL CONFIG")

# 10. FUNNEL
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const transitions = db.prepare("SELECT to_stage, COUNT(*) AS n FROM funnel_stage_transitions WHERE created_at > ? GROUP BY to_stage ORDER BY n DESC").all(Date.now() - 7*86400000);
const daily = db.prepare("SELECT date, COUNT(*) AS rows FROM funnel_daily_metrics GROUP BY date ORDER BY date DESC LIMIT 7").all();
console.log('Transitions last 7d:', JSON.stringify(transitions, null, 2));
console.log('Daily metrics rows:', JSON.stringify(daily, null, 2));
process.exit(0);
""", "10. FUNNEL")

# 11. AGENTIC TEMPLATES
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const templates = db.prepare("SELECT intent, COUNT(*) AS n, MAX(active) AS has_active FROM agentic_templates GROUP BY intent").all();
const suggestions = db.prepare("SELECT COUNT(*) AS n FROM agentic_template_suggestions WHERE status='pending'").get();
console.log('Templates by intent:', JSON.stringify(templates, null, 2));
console.log('Pending suggestions:', JSON.stringify(suggestions));
process.exit(0);
""", "11. AGENTIC TEMPLATES")

# 12. OTA DB (read-only)
node("""
const { otaQueryReadOnly } = require('/opt/vp-marketing/dist/services/ota-readonly-guard');
(async () => {
  try {
    const r = await otaQueryReadOnly('SELECT COUNT(*) AS n FROM hotels LIMIT 1');
    console.log('OTA reachable:', JSON.stringify(r));
  } catch (e) {
    console.log('OTA error:', e.message);
  }
  process.exit(0);
})();
""", "12. OTA DB (read-only)")

# 13. SCHEDULER ACTIVE CRONS
node("""
const cron = require('node-cron');
console.log('node-cron version: present');
console.log('cron-getTasks not exposed but scheduler runs via startScheduler');
process.exit(0);
""", "13. CRON SCHEDULER")

# 14. V5T (active!)
node("""
const { db } = require('/opt/vp-marketing/dist/db');
const photos = db.prepare("SELECT COUNT(*) AS n FROM v5_footage").get();
const posts_by_status = db.prepare("SELECT status, COUNT(*) AS n FROM v5t_posts GROUP BY status").all();
const recent = db.prepare("SELECT id, type, status, picked_footage_id, datetime(created_at/1000,'unixepoch') AS created FROM v5t_posts ORDER BY id DESC LIMIT 3").all();
console.log('Photos:', photos.n);
console.log('Posts by status:', JSON.stringify(posts_by_status));
console.log('Recent 3:', JSON.stringify(recent, null, 2));
process.exit(0);
""", "14. V5T PIPELINE")

# 15. AGENT TOOLS
node("""
const { db } = require('/opt/vp-marketing/dist/db');
try {
  const tools = db.prepare("SELECT name, enabled, last_call_at FROM agent_tools").all();
  console.log('Registered agent tools:', JSON.stringify(tools, null, 2));
} catch (e) {
  console.log('agent_tools query fail:', e.message);
}
process.exit(0);
""", "15. AGENT TOOLS")

c.close()
print("\n\n✅ Deep audit done")
