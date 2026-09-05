#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f dashboard/dist/index.html
test -f .env
test -x .runtime/node24/bin/node
test "$(.runtime/node24/bin/node -p 'process.versions.node.split(".")[0]')" = 24
mkdir -p .runtime reports
systemd-analyze verify deploy/botpoly.service
sudo -n install -m 0644 deploy/botpoly.service /etc/systemd/system/botpoly.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now botpoly.service
systemctl is-active botpoly.service
