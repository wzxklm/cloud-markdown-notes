#!/bin/sh
set -e

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install
fi

if [ -n "$WORKSPACE_ROOT" ]; then
  mkdir -p "$WORKSPACE_ROOT"
fi

exec "$@"
