#!/bin/bash
# ============================================
# VP Marketing — Deploy to VPS via SSH
# Usage: ./deploy-vps.sh root@YOUR_VPS_IP
# ============================================
set -e

VPS="${1:-root@YOUR_VPS_IP}"
APP_DIR="/opt/vp-marketing"
REPO="https://github.com/vuotquathuthach209-alt/vp-marketing.git"

echo "🚀 Deploying VP Marketing to $VPS..."
echo ""

# Step 1: Setup VPS (first time only)
ssh -o StrictHostKeyChecking=no "$VPS" bash -s "$APP_DIR" "$REPO" << 'REMOTE_SCRIPT'
APP_DIR=$1
REPO=$2

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo "📦 Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
fi

# Install git if not present
if ! command -v git &> /dev/null; then
  apt-get update && apt-get install -y git
fi

# Clone or pull
if [ -d "$APP_DIR" ]; then
  echo "📥 Pulling latest code..."
  cd "$APP_DIR"
  git pull origin main
else
  echo "📥 Cloning repository..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# Create .env if not exists
if [ ! -f .env ]; then
  echo "⚙️ Creating .env from .env.example..."
  cp .env.example .env
  # Generate random JWT secret
  JWT=$(openssl rand -hex 32)
  sed -i "s/replace-with-random-long-string-at-least-32-chars/$JWT/" .env
  echo ""
  echo "⚠️  IMPORTANT: Edit .env on VPS before first run:"
  echo "   nano $APP_DIR/.env"
  echo "   Set: ADMIN_PASSWORD, ANTHROPIC_API_KEY, OTA_DB_PASSWORD"
  echo ""
fi

# Create data directories
mkdir -p data/media data/uploads

# Build & deploy
echo "🔨 Building & starting containers..."
docker compose down 2>/dev/null || true
docker compose up -d --build

# Wait and check
sleep 5
if docker ps | grep -q marketing-auto; then
  echo ""
  echo "✅ Deploy thanh cong!"
  echo "   App: http://$(hostname -I | awk '{print $1}'):3000"
  echo "   Logs: docker logs -f marketing-auto"
  echo ""
  docker logs --tail 10 marketing-auto
else
  echo "❌ Container failed to start!"
  docker logs marketing-auto
  exit 1
fi
REMOTE_SCRIPT

echo ""
echo "✅ Done! VPS deployed successfully."
