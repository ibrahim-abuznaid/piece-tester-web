#!/usr/bin/env bash
# Reliable deploy script for piece-tester-web on DigitalOcean
#
# Do NOT run this file in place. The `git reset --hard` below rewrites this very
# file, and bash reads a script incrementally — it resumes at a stale byte offset
# in the new content and executes a spliced mix of the old and new versions.
# Pull first, then run an immutable copy:
#
#   ssh root@your-server 'cd /opt/piece-tester \
#     && git fetch origin && git reset --hard origin/main \
#     && install -m 755 deploy.sh /tmp/ptw-deploy.sh && bash /tmp/ptw-deploy.sh'
#
# CI (.github/workflows/deploy.yml) already does exactly this.

set -euo pipefail
cd /opt/piece-tester

# The PM2 registration must live under exactly ONE user. Two PM2 daemons cannot
# share port 4000 — the loser retries, exits, and PM2 restarts it forever. APP_USER
# owns data/ and has the enabled pm2-<user>.service unit that restores it on boot,
# so root must never end up holding a second registration.
APP_USER="${APP_USER:-deploy}"

run_as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    bash -lc "$1"
  else
    su - "$APP_USER" -c "$1"
  fi
}

echo "==> Pulling latest code (main)..."
git fetch origin
git checkout main
git reset --hard origin/main

echo "==> Installing dependencies..."
npm ci

echo "==> Building client..."
npm run build

echo "==> Handing writable paths to $APP_USER..."
chown -R "$APP_USER:$APP_USER" data logs dist node_modules 2>/dev/null || true

if [ "$(id -un)" != "$APP_USER" ]; then
  echo "==> Dropping any duplicate registration owned by $(id -un)..."
  pm2 delete piece-tester >/dev/null 2>&1 || true
  pm2 save --force >/dev/null 2>&1 || true
fi

echo "==> Restarting the app as $APP_USER..."
run_as_app "cd /opt/piece-tester && (pm2 restart piece-tester --update-env || pm2 start ecosystem.config.cjs)"
run_as_app "pm2 save"

echo "==> Waiting for health..."
for _ in $(seq 1 15); do
  if curl -fsS -m 5 localhost:4000/api/health >/dev/null 2>&1; then
    echo "==> Deploy complete — health OK"
    run_as_app "pm2 list --no-color" | grep -i piece-tester || true
    exit 0
  fi
  sleep 2
done

echo "!! Health check failed after ~30s — dumping recent logs" >&2
run_as_app "pm2 logs piece-tester --lines 30 --nostream --no-color" >&2 || true
exit 1
