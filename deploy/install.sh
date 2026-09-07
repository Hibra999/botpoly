#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f dist/src/app/run.js
test -f .env
test -x .runtime/node24/bin/node
test "$(.runtime/node24/bin/node -p 'process.versions.node')" = 24.20.0
systemd-analyze verify deploy/botpoly.service
sudo -n systemctl stop botpoly.service
sudo -n install -m 0644 deploy/botpoly.service /etc/systemd/system/botpoly.service
sudo -n -u gabo mkdir -p .runtime reports
sudo -n systemctl daemon-reload
sudo -n systemctl enable botpoly.service
# The migration holds the same lock as the launcher; a failure leaves the account stopped for review.
sudo -n -u gabo flock -n .runtime/engine.lock .runtime/node24/bin/node deploy/migrate.mjs
sudo -n systemctl start botpoly.service
systemctl is-active botpoly.service
