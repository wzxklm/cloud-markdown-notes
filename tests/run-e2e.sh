#!/bin/sh
set -u

status=0
report_root="runtime/fulltest-docker"
runner_log="$report_root/full-test-runner.log"

compose() {
  docker compose --env-file .env.dev --project-directory . -f docker/compose.yml -f docker/compose.test.yml "$@"
}

capture_logs() {
  mkdir -p "$report_root"
  compose logs --no-color > "$report_root/compose.log" || true
}

run_full_test() {
  mkdir -p "$report_root"
  rm -f "$runner_log"
  status_file="$report_root/full-test-runner.status"
  rm -f "$status_file"

  {
    compose exec -T app tsx tests/full-test-runner.ts
    printf '%s\n' "$?" > "$status_file"
  } 2>&1 | tee "$runner_log"

  command_status="$(cat "$status_file" 2>/dev/null || printf '1')"
  rm -f "$status_file"
  return "$command_status"
}

cleanup() {
  compose down || true
}

trap 'status=130; cleanup; exit "$status"' INT
trap 'status=143; cleanup; exit "$status"' TERM

compose up -d --build app db || status=$?
if [ "$status" -eq 0 ]; then
  run_full_test || status=$?
fi

if [ "$status" -ne 0 ]; then
  capture_logs
fi

cleanup
exit "$status"
