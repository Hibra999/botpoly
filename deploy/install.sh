#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f dist/src/app/run.js
test -f .env
test -x .runtime/node24/bin/node
test "$(.runtime/node24/bin/node -p 'process.versions.node')" = 24.20.0
mkdir -p .runtime reports
systemd-analyze verify deploy/botpoly.service
sudo -n install -m 0644 deploy/botpoly.service /etc/systemd/system/botpoly.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable botpoly.service
sudo -n systemctl restart botpoly.service
systemctl is-active botpoly.service
