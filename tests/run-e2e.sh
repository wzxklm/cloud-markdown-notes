#!/bin/sh
set -u

status=0
report_root="runtime/fulltest-docker"

compose() {
  docker compose --project-directory . -f docker/compose.yml -f docker/compose.test.yml "$@"
}

capture_logs() {
  mkdir -p "$report_root"
  compose logs --no-color > "$report_root/compose.log" || true
}

cleanup() {
  compose down || true
}

trap 'status=130; cleanup; exit "$status"' INT
trap 'status=143; cleanup; exit "$status"' TERM

compose up -d --build app db || status=$?
if [ "$status" -eq 0 ]; then
  compose exec -T app tsx tests/full-test-runner.ts || status=$?
fi

if [ "$status" -ne 0 ]; then
  capture_logs
fi

cleanup
exit "$status"
