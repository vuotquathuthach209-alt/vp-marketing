"""Audit which TS modules in src/ are unreferenced (orphans).

Strategy:
- For each .ts file, derive its base import name
- grep src/ for that import path
- If only the file itself shows up, it's orphan
"""
import os, sys, subprocess
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Collect all .ts files under src/
all_ts = []
for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".ts"):
            full = os.path.join(root, f).replace("\\", "/")
            all_ts.append(full)

print(f"Total .ts files in src/: {len(all_ts)}\n")

def find_refs(path):
    """Return list of files (excl path itself) that reference this module."""
    base_no_ext = path[:-3]                       # 'src/services/foo'
    rel = base_no_ext.replace("src/", "")         # 'services/foo'
    folder, name = os.path.split(rel)             # 'services', 'foo'

    # Search patterns
    patterns = [
        f"{rel}'",  f'{rel}"',                    # 'services/foo'
        f"/{name}'", f'/{name}"',                 # ends with /foo
    ]

    cmd = ["grep", "-rl", "--include=*.ts"]
    for p in patterns:
        cmd += ["-e", p]
    cmd.append("src/")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        files = [l for l in (r.stdout or "").strip().split("\n") if l and l != path]
        return files
    except Exception as e:
        return []

# Skip entry-point files
EXEMPT = {
    "src/index.ts",
    "src/db.ts",
    "src/config.ts",
    "src/middleware/auth.ts",  # if exists
}

orphans = []
checked = 0
for f in all_ts:
    if f in EXEMPT or f.endswith("/index.ts") or f.endswith("/types.ts"):
        continue
    checked += 1
    refs = find_refs(f)
    if not refs:
        sz = os.path.getsize(f)
        orphans.append((f, sz))

print(f"Checked {checked} files\n")
print(f"=== ORPHANS ({len(orphans)}) ===\n")
orphans.sort(key=lambda x: -x[1])
for f, sz in orphans:
    print(f"  {f}  ({sz:,} bytes)")
print(f"\nTotal orphan code size: {sum(s for _, s in orphans):,} bytes")
