#!/bin/sh
# Runs the end-to-end scenarios against a running stack: run.sh [name...]
# Defaults fit `docker compose up` with PORT=18082 APP_ORIGIN=http://localhost:18082.
cd "$(dirname "$0")" || exit 1
export POLYCODE_URL="${POLYCODE_URL:-http://localhost:18082}"
export S3_TEST_ENDPOINT="${S3_TEST_ENDPOINT:-localhost:9100}"
export S3_TEST_ACCESS_KEY="${S3_TEST_ACCESS_KEY:-polycode}"
export S3_TEST_SECRET_KEY="${S3_TEST_SECRET_KEY:-polycode-dev-secret}"
export S3_TEST_BUCKET="${S3_TEST_BUCKET:-polycode}"
[ $# -gt 0 ] || set -- persist delete public-copy mcp-tabs mcp-client agent-visible
status=0
for name in "$@"; do
  echo "== $name"
  node "$name.mjs" || status=1
done
exit $status
