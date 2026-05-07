"""Check DB tables for last-write activity → identify DEAD features.

Strategy:
- For each table, find max(created_at OR posted_at OR updated_at OR last_*)
- Tables with NO recent activity (30+ days) = likely dead feature
- Match table → feature module
"""
import paramiko, sys

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def sql(q, label=""):
    if label: print(f"\n=== {label} ===")
    _, o, _ = c.exec_command(f'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite "{q}"', timeout=30)
    out = o.read().decode("utf-8", errors="replace")
    print(out)
    return out


# 1. List all tables
print("=" * 70)
print("ALL DB TABLES")
print("=" * 70)
sql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    "tables"
)

# 2. Row count per table
print("\n" + "=" * 70)
print("ROW COUNTS (top 40 — tables with most rows)")
print("=" * 70)

# Get counts via dynamic query
_, o, _ = c.exec_command(
    """sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" """,
    timeout=10
)
tables = [t.strip() for t in o.read().decode("utf-8").split("\n") if t.strip()]
print(f"Found {len(tables)} tables\n")

counts = []
for t in tables:
    _, o, _ = c.exec_command(
        f"""sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT COUNT(*) FROM {t};" """,
        timeout=10
    )
    try:
        n = int(o.read().decode("utf-8").strip() or "0")
    except:
        n = 0
    counts.append((t, n))

# Empty tables (likely dead features)
empty = [t for t, n in counts if n == 0]
print(f"\n--- EMPTY TABLES ({len(empty)}) — likely dead features ---")
for t in sorted(empty):
    print(f"  {t}")

# Active tables sorted by row count
nonempty = [(t, n) for t, n in counts if n > 0]
nonempty.sort(key=lambda x: -x[1])
print(f"\n--- NON-EMPTY TABLES ({len(nonempty)}) sorted by row count ---")
for t, n in nonempty[:50]:
    print(f"  {n:>10}  {t}")

# 3. Check last activity timestamp for tables that have created_at/updated_at
print("\n" + "=" * 70)
print("LAST ACTIVITY (tables with timestamp column)")
print("=" * 70)

ts_cols = ["created_at", "updated_at", "posted_at", "last_metrics_at",
           "last_seen_at", "last_synced_at", "last_used_at", "synced_at",
           "scheduled_at", "uploaded_at"]

last_activity = []
for t, n in nonempty:
    if n == 0: continue
    # Get column list
    _, o, _ = c.exec_command(
        f"""sqlite3 /opt/vp-marketing/data/db.sqlite "PRAGMA table_info({t});" """,
        timeout=5
    )
    cols = [line.split("|")[1] for line in o.read().decode("utf-8").strip().split("\n") if "|" in line]

    # Find best timestamp column
    ts_col = None
    for c_name in ts_cols:
        if c_name in cols:
            ts_col = c_name
            break
    if not ts_col:
        continue

    _, o, _ = c.exec_command(
        f"""sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT MAX({ts_col}) FROM {t};" """,
        timeout=5
    )
    raw = o.read().decode("utf-8").strip()
    try:
        # Most timestamps in this app are unix ms
        ts = int(raw) if raw and raw != "" else 0
    except:
        ts = 0

    last_activity.append((t, n, ts_col, ts))

# Sort: oldest first
last_activity.sort(key=lambda x: x[3] or 0)

import datetime
now_ms = int(datetime.datetime.now().timestamp() * 1000)
print(f"\n{'TABLE':<40}  {'ROWS':>8}  {'LAST WRITE':<25}  {'AGE (days)':<10}")
print("-" * 95)
for t, n, col, ts in last_activity:
    if ts == 0:
        age = "?"
        last_str = "(no timestamp)"
    else:
        # Detect if seconds or ms
        if ts < 10_000_000_000:  # < year 2286 in seconds → it's seconds
            ts_ms = ts * 1000
        else:
            ts_ms = ts
        age_days = (now_ms - ts_ms) / 86400_000
        age = f"{age_days:.0f}"
        last_str = datetime.datetime.fromtimestamp(ts_ms / 1000).strftime("%Y-%m-%d %H:%M")
    print(f"  {t:<38}  {n:>8}  {last_str:<25}  {age:<10}")

c.close()
print("\n✅ Activity audit done")
