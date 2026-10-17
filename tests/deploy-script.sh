#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cat >"$tmp/git" <<'MOCK_GIT'
#!/usr/bin/env bash
set -Eeuo pipefail
last=''
for arg in "$@"; do last=$arg; done
case "$last" in
  HEAD) printf '%s\n' "${DEPLOY_TEST_HEAD:?}" ;;
  *'^{commit}')
    [[ ${DEPLOY_TEST_REVISION_EXISTS:-yes} == yes ]] || exit 1
    printf '%s\n' "${DEPLOY_TEST_RESOLVED:?}"
    ;;
  *)
    if [[ $* == *'status --porcelain=v1 --untracked-files=all'* ]]; then
      printf '%s' "${DEPLOY_TEST_DIRTY:-}"
    else
      echo 'unexpected git invocation' >&2
      exit 90
    fi
    ;;
esac
MOCK_GIT
chmod +x "$tmp/git"
for tool in docker npm; do
  cat >"$tmp/$tool" <<'MOCK_TOOL'
#!/usr/bin/env bash
echo "unexpected tool invocation: ${0##*/}" >>"${DEPLOY_TEST_TOOL_MARKER:?}"
exit 91
MOCK_TOOL
  chmod +x "$tmp/$tool"
done
cat >"$tmp/ssh" <<'MOCK_SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
echo ssh >>"${DEPLOY_TEST_TOOL_MARKER:?}"
cat >"${DEPLOY_TEST_REMOTE_SCRIPT:?}"
if [[ ${DEPLOY_TEST_PREFLIGHT_FAIL:-no} == yes ]]; then
  echo 'preflight: Compose interpolation or configuration validation failed' >&2
  exit 48
fi
printf 'PREFLIGHT_OK\tlinux/amd64\tghcr.io/vectorloom/smart-tv\n'
MOCK_SSH
chmod +x "$tmp/ssh"

sha=0123456789abcdef0123456789abcdef01234567
export PATH="$tmp:$PATH"
export DEPLOY_TEST_HEAD=$sha DEPLOY_TEST_RESOLVED=$sha
export DEPLOY_TEST_TOOL_MARKER="$tmp/tool-marker"
export DEPLOY_TEST_REMOTE_SCRIPT="$tmp/remote-script"

expect_fail() {
  local label=$1; shift
  if "$@" >"$tmp/out" 2>&1; then
    printf 'FAIL: %s unexpectedly succeeded\n' "$label" >&2
    exit 1
  fi
}

# Docker Compose records the config_files label as an ordered, comma-separated
# list of absolute paths. Keep the production checks exact and exercise the
# accepted label plus missing, extra, and unexpected path cases here.
expected_config_files='/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml'
label_matches_expected_files() { [[ $1 == "$expected_config_files" ]]; }
label_matches_expected_files '/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml' || {
  echo 'FAIL: actual absolute Compose config_files label was rejected' >&2; exit 1;
}
for invalid_files in \
  '/home/lazyboy/projects/smart-tv/compose.yaml' \
  '/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml,/home/lazyboy/projects/smart-tv/extra.yaml' \
  '/tmp/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml'; do
  if label_matches_expected_files "$invalid_files"; then
    printf 'FAIL: unexpected Compose config_files label was accepted: %s\n' "$invalid_files" >&2
    exit 1
  fi
done
[[ $(grep -Fc '[[ $files == "$expected_files" ]]' scripts/deploy.sh) -eq 2 ]] || {
  echo 'FAIL: both production checks must compare the complete expected Compose path list' >&2; exit 1;
}
grep -Fq "expected_files='/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml'" scripts/deploy.sh || {
  echo 'FAIL: production Compose path list is not pinned to the known directory and order' >&2; exit 1;
}
python3 tests/preflight-runtime.py

expect_fail 'missing argument' scripts/deploy.sh
expect_fail 'malformed SHA' scripts/deploy.sh abc
expect_fail 'SHA does not match HEAD' env DEPLOY_TEST_HEAD=ffffffffffffffffffffffffffffffffffffffff scripts/deploy.sh --dry-run "$sha"
expect_fail 'dirty worktree' env DEPLOY_TEST_DIRTY=' M tracked-file' scripts/deploy.sh --dry-run "$sha"
expect_fail 'revision absent locally' env DEPLOY_TEST_REVISION_EXISTS=no scripts/deploy.sh --dry-run "$sha"

output=$(scripts/deploy.sh --dry-run "$sha")
[[ $output == *"Dry run: local revision $sha matches clean HEAD."* ]] || { echo 'FAIL: dry-run did not report local validation' >&2; exit 1; }
[[ $output == *'No production connection or changes were made.'* ]] || { echo 'FAIL: dry-run did not confirm no production operations' >&2; exit 1; }
if [[ $output == *'Running frontend build'* || $output == *'Streaming only'* ]]; then
  echo 'FAIL: dry-run performed or claimed to perform deployment actions' >&2
  exit 1
fi
[[ ! -e $DEPLOY_TEST_TOOL_MARKER ]] || { echo 'FAIL: dry-run invoked Docker or SSH' >&2; exit 1; }

output=$(scripts/deploy.sh --preflight-only "$sha")
[[ $output == *"Read-only production preflight passed for $sha (linux/amd64). No deployment changes were made."* ]] || {
  echo 'FAIL: preflight-only did not report successful read-only preflight' >&2; exit 1;
}
[[ $(cat "$DEPLOY_TEST_TOOL_MARKER") == ssh ]] || { echo 'FAIL: preflight-only invoked a local build/deployment tool' >&2; exit 1; }
grep -Fq 'compose config --quiet' "$DEPLOY_TEST_REMOTE_SCRIPT" || { echo 'FAIL: preflight-only did not reach remote preflight' >&2; exit 1; }
if grep -Eq 'docker (build|save|load|tag)|compose .* up|curl ' "$DEPLOY_TEST_REMOTE_SCRIPT"; then
  echo 'FAIL: preflight-only remote script contains a mutation or deployment operation' >&2; exit 1;
fi

rm -f "$DEPLOY_TEST_TOOL_MARKER"
if output=$(env DEPLOY_TEST_PREFLIGHT_FAIL=yes scripts/deploy.sh --preflight-only "$sha" 2>&1); then
  echo 'FAIL: failed preflight unexpectedly succeeded' >&2; exit 1
fi
[[ $output == *'remote read-only preflight failed; no production changes were made'* ]] || {
  echo 'FAIL: failed preflight did not return a useful safe diagnostic' >&2; exit 1;
}
[[ $(cat "$DEPLOY_TEST_TOOL_MARKER") == ssh ]] || { echo 'FAIL: failed preflight continued to another operation' >&2; exit 1; }

# Static safety assertions cover the remote path without needing SSH or Docker.
! grep -q 'docker compose down' scripts/deploy.sh || { echo 'FAIL: destructive Compose down command present' >&2; exit 1; }
! grep -q -- '--env-file\|milestone3-predeploy\|\.env missing\|\.env unavailable' scripts/deploy.sh || { echo 'FAIL: deployment assumes or uses a protected backup as Compose input' >&2; exit 1; }
grep -Fq 'docker save "$image_ref" | ssh' scripts/deploy.sh || { echo 'FAIL: image is not streamed through SSH' >&2; exit 1; }
grep -Fq 'set -Eeuo pipefail' scripts/deploy.sh || { echo 'FAIL: pipeline failures may be masked' >&2; exit 1; }
grep -Fq 'compose -f "$dir/compose.yaml" -f "$dir/compose.settings.yaml" -f "$override" "$@"' scripts/deploy.sh || { echo 'FAIL: deployment does not use both production Compose files' >&2; exit 1; }
[[ $(grep -c 'up -d --no-build --no-deps dashboard' scripts/deploy.sh) -eq 2 ]] || { echo 'FAIL: deploy and rollback must both target dashboard only' >&2; exit 1; }
! grep -Eq 'docker (image )?rm|docker rmi' scripts/deploy.sh || { echo 'FAIL: script may remove an image before health checks' >&2; exit 1; }
grep -Fq 'canonical(running) != canonical(expected)' scripts/preflight-runtime.py || { echo 'FAIL: explicit Compose and running image refs are not compared' >&2; exit 1; }
grep -Fq 'image_ids != [inspect.get("Image")]' scripts/preflight-runtime.py || { echo 'FAIL: Compose dashboard image is not matched to its running container' >&2; exit 1; }
grep -Fq 'runtime configuration changed or cannot be validated' scripts/deploy.sh || { echo 'FAIL: runtime configuration is not revalidated before recreation' >&2; exit 1; }
grep -Fq 'local_platform == "$remote_platform"' scripts/deploy.sh || { echo 'FAIL: local/remote image platform check missing' >&2; exit 1; }
grep -Fq 'local_revision == "$sha"' scripts/deploy.sh || { echo 'FAIL: source revision image label is not verified' >&2; exit 1; }
grep -Fq 'revision image tag already exists' scripts/deploy.sh || { echo 'FAIL: existing remote SHA image tag could be overwritten' >&2; exit 1; }
grep -Fq 'docker info >/dev/null 2>&1 || exit 71' scripts/deploy.sh || { echo 'FAIL: remote Docker verification does not fail closed' >&2; exit 1; }
grep -Fq 'SMART_TV_IMMICH_ADDRESSES=10.0.0.11' scripts/deploy.sh || { echo 'FAIL: known production interpolation export is not supplied' >&2; exit 1; }
grep -Fq 'python3 -c "$(printf' scripts/deploy.sh || { echo 'FAIL: read-only preflight does not run the transported diagnostic validator' >&2; exit 1; }
grep -Fq 'deployment_health=' scripts/deploy.sh || { echo 'FAIL: deployment health outcome is not tracked' >&2; exit 1; }
grep -Fq 'docker inspect --format '\''{{.Image}}'\'' "$container") == "$old_id"' scripts/deploy.sh || { echo 'FAIL: rollback does not verify restoration of the previous image' >&2; exit 1; }
grep -Fq 'docker tag "$old_id" "$rollback_ref"' scripts/deploy.sh || { echo 'FAIL: rollback does not retain the previous image under a separate tag' >&2; exit 1; }
printf 'deploy-script tests passed\n'
