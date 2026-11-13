#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
if [[ -n ${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-} ]]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
else
  unset PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
fi
exec npm run test:browser --prefix src/web -- "$@"
