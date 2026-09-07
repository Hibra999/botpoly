#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p .runtime reports
exec 9>.runtime/engine.lock
if ! flock -n 9; then
  echo 'Botpoly ya tiene una instancia activa.' >&2
  exit 75
fi
botpoly_node="$PWD/.runtime/node24/bin/node"
if [[ ! -x "$botpoly_node" ]]; then botpoly_node="$(command -v node)"; fi
if [[ "$("$botpoly_node" -p 'process.versions.node')" != '24.20.0' ]]; then
  echo 'Se requiere Node 24.20.0.' >&2
  exit 1
fi
exec "$botpoly_node" dist/src/app/run.js
