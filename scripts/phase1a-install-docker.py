"""PHASE 1A: Install Docker + Docker Compose plugin trên VPS Sonder.

Reference: https://docs.docker.com/engine/install/ubuntu/
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
set -e
echo '═══ STEP 1: Cleanup any old Docker installations ═══'
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  apt-get -y remove $pkg 2>/dev/null || true
done

echo
echo '═══ STEP 2: Install prerequisites ═══'
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg

echo
echo '═══ STEP 3: Add Docker official GPG key ═══'
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo
echo '═══ STEP 4: Add Docker repository ═══'
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -qq

echo
echo '═══ STEP 5: Install Docker Engine + Compose plugin ═══'
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo
echo '═══ STEP 6: Enable + start Docker ═══'
systemctl enable docker
systemctl start docker

echo
echo '═══ STEP 7: Verify ═══'
docker --version
docker compose version
docker run --rm hello-world 2>&1 | tail -5
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=300, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()
