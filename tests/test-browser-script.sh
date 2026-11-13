#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cat >"$tmp/npm" <<'MOCK_NPM'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s' "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH-<unset>}" >"${BROWSER_TEST_PATH_OUTPUT:?}"
printf '%s\n' "$@" >"${BROWSER_TEST_ARGS_OUTPUT:?}"
MOCK_NPM
chmod +x "$tmp/npm"
export PATH="$tmp:$PATH"
export BROWSER_TEST_PATH_OUTPUT="$tmp/path" BROWSER_TEST_ARGS_OUTPUT="$tmp/args"

env -u PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH bash scripts/test-browser.sh --list
[[ $(cat "$BROWSER_TEST_PATH_OUTPUT") == '<unset>' ]] || {
  echo 'FAIL: default browser wrapper set an executable override' >&2; exit 1;
}
[[ $(cat "$BROWSER_TEST_ARGS_OUTPUT") == $'run\ntest:browser\n--prefix\nsrc/web\n--\n--list' ]] || {
  echo 'FAIL: browser wrapper changed the Playwright command or arguments' >&2; exit 1;
}

env PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/custom/chromium bash scripts/test-browser.sh --list
[[ $(cat "$BROWSER_TEST_PATH_OUTPUT") == /custom/chromium ]] || {
  echo 'FAIL: explicit browser executable override was not preserved' >&2; exit 1;
}

env PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH= bash scripts/test-browser.sh --list
[[ $(cat "$BROWSER_TEST_PATH_OUTPUT") == '<unset>' ]] || {
  echo 'FAIL: empty browser executable override was passed to Playwright' >&2; exit 1;
}

grep -Fq 'launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}' src/web/playwright.config.ts || {
  echo 'FAIL: Playwright config does not omit executablePath by default' >&2; exit 1;
}
grep -Fq '...(executablePath ? { executablePath } : {})' src/web/e2e/settings.spec.ts || {
  echo 'FAIL: explicit administrator browser launch does not omit an unset executablePath' >&2; exit 1;
}
echo 'test-browser-script tests passed'
