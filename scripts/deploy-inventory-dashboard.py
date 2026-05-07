"""Deploy inventory dashboard:
1. Pull + build + restart pm2
2. Add nginx alias /v5t-footage/ → /var/sonder-real-footage/
3. Reload nginx
4. Smoke test endpoints
"""
import sys, paramiko

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def run(cmd, label="", timeout=180):
    print(f"\n=== {label or cmd[:60]} ===")
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    if out.strip(): print(out[-3000:])
    if err.strip() and "warning" not in err.lower(): print(f"[stderr] {err[-1500:]}")
    return out


# 1. Pull + build + restart
run("cd /opt/vp-marketing && git pull origin main", "pull")
run("cd /opt/vp-marketing && npm run build 2>&1 | tail -5", "build", timeout=300)
run("pm2 restart vp-mkt && sleep 2", "restart")

# 2. Check current nginx config
print("\n=== current app.sondervn.com nginx config ===")
out = run('grep -n "v5t-out\\|v5t-footage" /etc/nginx/sites-enabled/app.sondervn.com', "check existing aliases")

# 3. Inject /v5t-footage/ alias if missing
if "v5t-footage" not in out:
    print("\n=== adding /v5t-footage/ alias to nginx ===")
    # Insert after the existing /v5t-out/ block
    inject_cmd = """
sed -i '/location \\/v5t-out\\//,/^    }/{
  /^    }/a\\
\\
    location /v5t-footage/ {\\
        alias /var/sonder-real-footage/;\\
        autoindex off;\\
        expires 30d;\\
        add_header Cache-Control "public, immutable";\\
    }
}' /etc/nginx/sites-enabled/app.sondervn.com
"""
    run(inject_cmd, "inject alias")
    run("nginx -t 2>&1", "test nginx config")
    run("systemctl reload nginx", "reload nginx")
else:
    print("✓ /v5t-footage/ alias already exists")

# 4. Verify nginx config
run('grep -A 5 "v5t-footage" /etc/nginx/sites-enabled/app.sondervn.com', "verify alias")

# 5. Test endpoints
print("\n" + "=" * 60)
print("Smoke tests:")
run("curl -sf -o /dev/null -w 'inventory JSON: %{http_code}\\n' http://localhost:3000/admin/v5t/inventory", "test JSON")
run("curl -sf -o /dev/null -w 'inventory HTML: %{http_code}\\n' http://localhost:3000/admin/v5t/inventory-view", "test HTML")
run("curl -s http://localhost:3000/admin/v5t/inventory | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d[\"summary\"], indent=2))'", "summary preview")

# 6. Test photo URL via nginx
out = run("ls /var/sonder-real-footage/ | head -1", "first photo filename")
if out.strip():
    fn = out.strip().split("\n")[0]
    run(f"curl -sf -o /dev/null -w 'thumb URL: %{{http_code}}\\n' https://app.sondervn.com/v5t-footage/{fn}", "test thumbnail URL")

c.close()
print("\n✅ Inventory dashboard deployed")
print("   Visit: https://app.sondervn.com/admin/v5t/inventory-view")
