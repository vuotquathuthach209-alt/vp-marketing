"""Audit orphan modules — v2 with broader pattern matching.

Strategy: for each .ts file, search for any import that resolves to it.
Match by the BASENAME (without ext) anywhere in import/require strings.
"""
import os, sys, subprocess, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EXCLUDE_DIRS = {".git", "node_modules", "dist", "build"}
SCRIPTS_PREFIX = "src/scripts/"  # one-off scripts, expected to be standalone

# Collect all .ts files
all_ts = []
for root, dirs, files in os.walk("src"):
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
    for f in files:
        if f.endswith(".ts") and not f.endswith(".d.ts"):
            full = os.path.join(root, f).replace("\\", "/")
            all_ts.append(full)

print(f"Total .ts files in src/: {len(all_ts)}\n")

# Read ALL files content once, then search in-memory (much faster)
contents = {}
for f in all_ts:
    try:
        with open(f, "r", encoding="utf-8") as fh:
            contents[f] = fh.read()
    except Exception:
        contents[f] = ""

def is_referenced(path):
    """Return list of files that reference this module via import/require."""
    # The module's relative path from src/, no extension
    rel_no_ext = path[len("src/"):][:-3]   # 'routes/foo' or 'services/v5t/bar'
    name = os.path.basename(rel_no_ext)    # 'foo' / 'bar'
    folder = os.path.dirname(rel_no_ext)   # 'routes' / 'services/v5t'

    # Patterns that should match a real import:
    # - 'X/foo' or "X/foo" (where X ends with the parent folder name)
    # - 'foo' or "foo" with a leading ./ or ../  → e.g. './foo' or '../foo'
    # - Match in import/require/from statements
    pats = [
        re.compile(rf"['\"]\.+/[^'\"]*?{re.escape(name)}['\")]"),
    ]
    # Also match 'routes/foo' or 'services/foo' etc. without leading ./
    if folder:
        pats.append(re.compile(rf"['\"][^'\"]*?{re.escape(folder)}/{re.escape(name)}['\")]"))

    referrers = []
    for f, content in contents.items():
        if f == path:
            continue
        for p in pats:
            if p.search(content):
                referrers.append(f)
                break
    return referrers

# Categorize
true_orphans = []
script_orphans = []
referenced = 0

for f in all_ts:
    if f.endswith("/types.ts"):
        # types files are imported by TypeScript implicitly via re-exports — skip
        continue
    if f == "src/index.ts" or f == "src/db.ts" or f == "src/config.ts":
        continue
    refs = is_referenced(f)
    if not refs:
        if f.startswith(SCRIPTS_PREFIX):
            script_orphans.append(f)
        else:
            true_orphans.append(f)
    else:
        referenced += 1

print(f"Referenced: {referenced}")
print(f"True orphans (NOT in scripts/): {len(true_orphans)}")
print(f"Script orphans (one-offs in scripts/): {len(script_orphans)}\n")

print("=== TRUE ORPHANS (likely deletable) ===\n")
for f in sorted(true_orphans, key=lambda x: -os.path.getsize(x)):
    sz = os.path.getsize(f)
    print(f"  {f}  ({sz:,} bytes)")

print(f"\nTotal true-orphan size: {sum(os.path.getsize(f) for f in true_orphans):,} bytes")

print("\n=== ONE-OFF SCRIPTS (likely deletable) ===\n")
for f in sorted(script_orphans, key=lambda x: -os.path.getsize(x)):
    sz = os.path.getsize(f)
    print(f"  {f}  ({sz:,} bytes)")
print(f"\nTotal script-orphan size: {sum(os.path.getsize(f) for f in script_orphans):,} bytes")
