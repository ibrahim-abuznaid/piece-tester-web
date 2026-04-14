#!/usr/bin/env bash
# Reliable deploy script for piece-tester-web on DigitalOcean
# Usage: ssh root@your-server "cd /opt/piece-tester && bash deploy.sh"

set -e
cd /opt/piece-tester

echo "==> Pulling latest code..."
git pull

echo "==> Stopping PM2 process (if running)..."
pm2 stop piece-tester 2>/dev/null || true
pm2 delete piece-tester 2>/dev/null || true

echo "==> Killing anything on port 4000..."
fuser -k 4000/tcp 2>/dev/null || true
sleep 1

echo "==> Starting with ecosystem config..."
pm2 start ecosystem.config.cjs
pm2 save

echo "==> Deploy complete."
pm2 list
