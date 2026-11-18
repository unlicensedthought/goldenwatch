#!/usr/bin/env bash
# trunkq runs this for every land. Contract: the last stdout line is `VERIFY {json}`.
set -uo pipefail
cd "$(dirname "$0")/.."
step() {
  local name="$1"; shift
  if ! "$@"; then
    echo "VERIFY {\"verdict\":\"fail\",\"failed\":\"$name\"}"
    exit 1
  fi
}
step install npm ci --no-audit --no-fund
step typecheck npm run typecheck
step test npm test
step build npm run build
echo 'VERIFY {"verdict":"pass","gates":3}'
