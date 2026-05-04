"""
Sync files từ VPS về local (Option 3 — vào branch wip-vps-sync).

Strategy:
- Download toàn bộ src/* + package.json + package-lock.json từ VPS
- KHÔNG touch: data/, dist/, node_modules/, .env*, ocr-service/venv/, .git/
- Local sẽ thấy diff qua git status
"""
import sys, os, paramiko, posixpath
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
LOCAL_ROOT = r"C:\Users\USER\tự động đăng facebook"
REMOTE_ROOT = "/opt/vp-marketing"

# Whitelist directories/files to sync
SYNC_PATHS = [
    "src",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
]

# Skip these subpaths (relative to remote_root)
SKIP_PATTERNS = [
    "node_modules",
    ".git",
    "dist",
    "data",
    ".env",
    ".env.bak",
    ".env.bak2",
    "ocr-service/venv",
    "gen_series_smoke.cjs",
    ".pm2",
]

def should_skip(path: str) -> bool:
    for pattern in SKIP_PATTERNS:
        if pattern in path:
            return True
    return False


def sync_dir(sftp, remote_dir: str, local_dir: str, stats: dict):
    """Recursive sync 1 directory."""
    if should_skip(remote_dir):
        return

    try:
        items = sftp.listdir_attr(remote_dir)
    except IOError as e:
        print(f"  ⚠️ Cannot list {remote_dir}: {e}")
        return

    if not os.path.exists(local_dir):
        os.makedirs(local_dir, exist_ok=True)
        stats["created_dirs"] += 1

    for item in items:
        remote_path = posixpath.join(remote_dir, item.filename)
        local_path = os.path.join(local_dir, item.filename)

        if should_skip(remote_path):
            stats["skipped"] += 1
            continue

        # Directory
        if (item.st_mode & 0o170000) == 0o040000:
            sync_dir(sftp, remote_path, local_path, stats)
        else:
            # File — download
            try:
                # Skip if local has same size + mtime (quick check)
                # But we want fresh copy → always download
                sftp.get(remote_path, local_path)
                stats["files"] += 1
                if stats["files"] % 50 == 0:
                    print(f"  ... {stats['files']} files synced")
            except Exception as e:
                print(f"  ❌ Failed {remote_path}: {e}")
                stats["errors"] += 1


def sync_file(sftp, remote_path: str, local_path: str, stats: dict):
    """Sync single file."""
    try:
        # Make parent dirs if needed
        parent = os.path.dirname(local_path)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)

        sftp.get(remote_path, local_path)
        stats["files"] += 1
    except Exception as e:
        print(f"  ❌ Failed {remote_path}: {e}")
        stats["errors"] += 1


def main():
    stats = {"files": 0, "skipped": 0, "errors": 0, "created_dirs": 0}

    print("=" * 60)
    print(f"Syncing từ VPS {HOST} → {LOCAL_ROOT}")
    print("=" * 60)

    transport = paramiko.Transport((HOST, 22))
    transport.connect(username="root", password=PASSWORD)
    sftp = paramiko.SFTPClient.from_transport(transport)

    for path in SYNC_PATHS:
        remote = posixpath.join(REMOTE_ROOT, path)
        local = os.path.join(LOCAL_ROOT, path)

        # Check if remote is dir or file
        try:
            stat = sftp.stat(remote)
            is_dir = (stat.st_mode & 0o170000) == 0o040000
        except IOError:
            print(f"  ⚠️ {remote} không tồn tại, skip")
            continue

        print(f"\n📁 Syncing: {path} ({'DIR' if is_dir else 'FILE'})")
        if is_dir:
            sync_dir(sftp, remote, local, stats)
        else:
            sync_file(sftp, remote, local, stats)

    sftp.close()
    transport.close()

    print()
    print("=" * 60)
    print(f"✅ Done!")
    print(f"  Files synced: {stats['files']}")
    print(f"  Dirs created: {stats['created_dirs']}")
    print(f"  Skipped: {stats['skipped']}")
    print(f"  Errors: {stats['errors']}")
    print("=" * 60)


if __name__ == "__main__":
    main()
