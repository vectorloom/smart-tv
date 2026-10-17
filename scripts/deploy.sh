#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE_HOST='lazyboy@10.0.0.11'
readonly REMOTE_DIR='/home/lazyboy/projects/smart-tv'
readonly EXPECTED_CONTAINER='smart-tv-dashboard-1'
readonly HEALTH_URL='http://10.0.0.11:8080/api/health'
readonly HEALTH_ATTEMPTS=30

usage() {
  cat <<'USAGE'
Usage: scripts/deploy.sh [--dry-run | --preflight-only] <40-character-commit-sha>

Build and deploy the current, clean checkout to the Smart TV Dashboard.
The SHA must identify HEAD exactly. Deployment transfers only the built Docker
image over SSH and recreates only the dashboard service.

Options:
  -n, --dry-run  Validate the local checkout and print the intended workflow.
                Does not run tests, build an image, or connect to production.
      --preflight-only  Run local validation and read-only production preflight,
                then exit before tests, builds, transfers, or deployment.
  -h, --help     Show this help.

The deployment requires SSH access to lazyboy@10.0.0.11, Docker access locally
and remotely, and the protected production settings material already provisioned
in the production checkout. Compose interpolation must match the running service.
USAGE
}

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

dry_run=false
preflight_only=false
while (($#)); do
  case "$1" in
    --dry-run|-n) $dry_run && die 'specify --dry-run only once'; dry_run=true; shift ;;
    --preflight-only) $preflight_only && die 'specify --preflight-only only once'; preflight_only=true; shift ;;
    --help|-h) usage; exit 0 ;;
    --*) die "unknown option: $1" ;;
    *) break ;;
  esac
done
if $dry_run && $preflight_only; then die '--dry-run and --preflight-only are mutually exclusive'; fi
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
sha=$1
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die 'revision must be a full, lowercase 40-character Git SHA'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)
cd -- "$repo_root"

command -v git >/dev/null 2>&1 || die 'git is required locally'
resolved=$(git rev-parse --verify "$sha^{commit}" 2>/dev/null) || die 'revision does not exist locally'
[[ $resolved == "$sha" ]] || die 'revision did not resolve to the requested commit'
head=$(git rev-parse --verify HEAD 2>/dev/null) || die 'cannot resolve HEAD'
[[ $head == "$sha" ]] || die 'requested revision must match HEAD'
if [[ -n $(git status --porcelain=v1 --untracked-files=all 2>/dev/null) ]]; then
  die 'working tree is not clean; refusing to deploy'
fi

for required in Dockerfile .dockerignore compose.yaml compose.settings.yaml \
  scripts/test-api.sh scripts/build-test-host.sh scripts/test-browser.sh; do
  [[ -f $required ]] || die "required repository file is missing: $required"
done

if $dry_run; then
  printf 'Dry run: local revision %s matches clean HEAD.\n' "$sha"
  printf 'Would run the five pre-deployment checks, verify remote Compose/runtime state, then build a SHA-tagged image from the repository root.\n'
  printf 'Would stream only the verified image to %s and deploy dashboard only.\n' "$REMOTE_HOST"
  printf 'Would poll %s and attempt dashboard-only rollback on failure. No production connection or changes were made.\n' "$HEALTH_URL"
  exit 0
fi

remote_preflight() {
# This check is read-only. Compose receives the known, previously exported
# non-secret setting. Its resolved configuration must match the live dashboard.
validator_b64=$(base64 <"$script_dir/preflight-runtime.py" | tr -d '\n')
remote_preflight=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" bash -s -- "$EXPECTED_CONTAINER" "$REMOTE_DIR" "$validator_b64" <<'REMOTE_PREFLIGHT'
set -Eeuo pipefail
expected_container=$1
expected_dir='/home/lazyboy/projects/smart-tv'
validator_b64=$3
[[ $2 == "$expected_dir" ]] || exit 40
host_ips=$(hostname -I 2>/dev/null) || { echo 'preflight: cannot identify SSH host' >&2; exit 41; }
host_matches=false
for host_ip in $host_ips; do [[ $host_ip == 10.0.0.11 ]] && host_matches=true; done
$host_matches || { echo 'preflight: unexpected SSH host' >&2; exit 41; }
[[ -d $expected_dir ]] || { echo 'preflight: deployment directory missing' >&2; exit 42; }
cd -- "$expected_dir"
for f in compose.yaml compose.settings.yaml; do
  [[ -f $f ]] || { echo 'preflight: required Compose file missing' >&2; exit 43; }
done
compose() {
  env -i PATH="$PATH" HOME="$HOME" SMART_TV_IMMICH_ADDRESSES=10.0.0.11 docker compose -p smart-tv -f compose.yaml -f compose.settings.yaml "$@"
}
if ! compose config --quiet >/dev/null 2>&1; then
  echo 'preflight: Compose interpolation or configuration validation failed' >&2; exit 48
fi
[[ $(docker ps --filter "name=^/${expected_container}$" --filter 'status=running' --format '{{.Names}}') == "$expected_container" ]] || { echo 'preflight: expected dashboard container is not running' >&2; exit 51; }
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$expected_container") == smart-tv ]] || { echo 'preflight: dashboard belongs to an unexpected Compose project' >&2; exit 52; }
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$expected_container") == dashboard ]] || { echo 'preflight: expected service label is missing' >&2; exit 53; }
workdir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$expected_container")
[[ $workdir == "$expected_dir" ]] || { echo 'preflight: running dashboard uses a different Compose directory' >&2; exit 54; }
files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$expected_container")
expected_files='/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml'
[[ $files == "$expected_files" ]] || { echo 'preflight: running dashboard does not use the expected Compose files' >&2; exit 55; }
[[ $(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$expected_container" | grep -c '^Immich__ApiKey=.') -eq 1 ]] || {
  # The key may be persisted in the protected settings volume instead of the environment.
  [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Name}}{{end}}{{end}}' "$expected_container") == smart-tv_settings ]] || {
    echo 'preflight: neither a configured Immich key nor the managed settings volume is present' >&2; exit 56;
  }
}
platform=$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null) || { echo 'preflight: cannot inspect remote Docker platform' >&2; exit 57; }
[[ $platform == */* ]] || { echo 'preflight: invalid remote Docker platform' >&2; exit 58; }
# Validate resolved runtime configuration against the currently running service
# in memory. The validator reports mismatch categories and non-secret metadata;
# Compose's expanded configuration is never written to a file or emitted.
images=$(compose config --images 2>/dev/null) || { echo 'preflight: cannot resolve Compose image references' >&2; exit 49; }
service_image_ids=$(compose images -q dashboard 2>/dev/null) || { echo 'preflight: cannot resolve the dashboard Compose image' >&2; exit 49; }
image_repo=$(compose config --format json 2>/dev/null | COMPOSE_IMAGE_LIST="$images" COMPOSE_SERVICE_IMAGE_IDS="$service_image_ids" python3 -c "$(printf '%s' "$validator_b64" | base64 -d)") || {
  echo 'preflight: resolved Compose image/runtime configuration cannot be proven to match the running dashboard' >&2; exit 59;
}
printf 'PREFLIGHT_OK\t%s\t%s\n' "$platform" "$image_repo"
REMOTE_PREFLIGHT
) || die 'remote read-only preflight failed; no production changes were made'

  IFS=$'\t' read -r preflight_marker remote_platform image_repo <<<"${remote_preflight##*$'\n'}"
  [[ $preflight_marker == PREFLIGHT_OK && -n $remote_platform && -n $image_repo ]] || die 'remote preflight returned an invalid result'
  printf '%s\t%s\n' "$remote_platform" "$image_repo"
}

if $preflight_only; then
  command -v ssh >/dev/null 2>&1 || die 'ssh is required locally'
  result=$(remote_preflight) || die 'remote read-only preflight failed; no production changes were made'
  IFS=$'\t' read -r remote_platform image_repo <<<"$result"
  printf 'Read-only production preflight passed for %s (%s). No deployment changes were made.\n' "$sha" "$remote_platform"
  exit 0
fi

for tool in npm docker ssh; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required locally"; done

printf 'Running frontend build...\n'
npm run build --prefix src/web
printf 'Running frontend unit tests...\n'
npm test --prefix src/web
printf 'Running API tests...\n'
scripts/test-api.sh
printf 'Building browser test host...\n'
scripts/build-test-host.sh
printf 'Running browser tests...\n'
scripts/test-browser.sh

result=$(remote_preflight) || die 'remote read-only preflight failed; no production changes were made'
IFS=$'\t' read -r remote_platform image_repo <<<"$result"

image_ref="${image_repo}:${sha}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "docker info >/dev/null 2>&1 || exit 71; if docker image inspect '$image_ref' >/dev/null 2>&1; then echo 'preflight: revision image tag already exists; refusing to overwrite it' >&2; exit 70; else exit 0; fi"; then
  :
else
  die 'remote revision image tag is already present or could not be checked; no image was transferred'
fi

printf 'Building %s...\n' "$image_ref"
docker build --label "org.opencontainers.image.revision=$sha" --tag "$image_ref" --file "$repo_root/Dockerfile" "$repo_root"
local_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref") || die 'cannot inspect the locally built image'
[[ $local_platform == */* ]] || die 'could not determine the local image platform'
[[ $local_platform == "$remote_platform" ]] || die "image platform mismatch (local $local_platform, remote $remote_platform)"
local_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref") || die 'cannot inspect the image revision label'
[[ $local_revision == "$sha" ]] || die 'local image revision label does not match the requested SHA'

printf 'Streaming only %s to %s...\n' "$image_ref" "$REMOTE_HOST"
if ! docker save "$image_ref" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "docker info >/dev/null 2>&1 || exit 71; if docker image inspect '$image_ref' >/dev/null 2>&1; then echo 'transfer: revision image tag already exists' >&2; exit 70; else docker load >/dev/null; fi"; then
  die 'image transfer failed; the production service was not changed'
fi

# Deployment and rollback run remotely. The temporary Compose override lives in
# /tmp, not the checkout, and lets Compose use the immutable SHA tag without
# replacing the previous Compose image tag.
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" bash -s -- "$sha" "$image_repo" "$EXPECTED_CONTAINER" "$HEALTH_URL" "$HEALTH_ATTEMPTS" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
sha=$1
image=$2
container=$3
health_url=$4
attempts=$5
dir='/home/lazyboy/projects/smart-tv'
cd -- "$dir"
compose() {
  env -i PATH="$PATH" HOME="$HOME" SMART_TV_IMMICH_ADDRESSES=10.0.0.11 docker compose -p smart-tv -f compose.yaml -f compose.settings.yaml "$@"
}
# Repeat critical read-only checks after transfer, before changing service state.
host_ips=$(hostname -I 2>/dev/null) || { echo 'deploy: cannot identify SSH host' >&2; exit 60; }
host_matches=false
for host_ip in $host_ips; do [[ $host_ip == 10.0.0.11 ]] && host_matches=true; done
$host_matches || { echo 'deploy: unexpected SSH host' >&2; exit 60; }
if ! compose config --quiet >/dev/null 2>&1; then echo 'deploy: Compose validation failed' >&2; exit 62; fi
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container") == smart-tv ]] || { echo 'deploy: dashboard project changed after preflight' >&2; exit 62; }
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container") == dashboard ]] || { echo 'deploy: dashboard service changed after preflight' >&2; exit 62; }
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container") == "$dir" ]] || { echo 'deploy: dashboard working directory changed after preflight' >&2; exit 62; }
files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
expected_files='/home/lazyboy/projects/smart-tv/compose.yaml,/home/lazyboy/projects/smart-tv/compose.settings.yaml'
[[ $files == "$expected_files" ]] || { echo 'deploy: dashboard Compose files changed after preflight' >&2; exit 62; }
[[ $(docker ps --filter "name=^/${container}$" --filter 'status=running' --format '{{.Names}}') == "$container" ]] || { echo 'deploy: dashboard is no longer running' >&2; exit 63; }
new_ref="$image:$sha"
new_id=$(docker image inspect --format '{{.Id}}' "$new_ref") || { echo 'deploy: transferred image is unavailable' >&2; exit 64; }
images=$(compose config --images 2>/dev/null) || { echo 'deploy: cannot revalidate Compose images' >&2; exit 64; }
service_image_ids=$(compose images -q dashboard 2>/dev/null) || { echo 'deploy: cannot revalidate dashboard image' >&2; exit 64; }
if ! compose config --format json 2>/dev/null | COMPOSE_IMAGE_LIST="$images" COMPOSE_SERVICE_IMAGE_IDS="$service_image_ids" NEW_IMAGE_ID="$new_id" python3 -c '
import json, os, sys
try:
    config=json.load(sys.stdin); service=config["services"]["dashboard"]
    inspect=json.loads(__import__("subprocess").check_output(["docker","inspect","smart-tv-dashboard-1"],text=True))[0]
    canonical=lambda name: name if "@" in name or ":" in name.rsplit("/",1)[-1] else name+":latest"
    running=inspect["Config"]["Image"]; expected=service.get("image")
    if expected and canonical(expected)!=canonical(running): raise ValueError()
    if canonical(running) not in {canonical(n) for n in os.environ["COMPOSE_IMAGE_LIST"].splitlines()}: raise ValueError()
    if os.environ["COMPOSE_SERVICE_IMAGE_IDS"].splitlines()!=[inspect["Image"]]: raise ValueError()
    desired={str(k):str(v) for k,v in service.get("environment",{}).items()}
    current=dict(item.split("=",1) for item in inspect["Config"].get("Env",[]) if "=" in item)
    image_config=json.loads(__import__("subprocess").check_output(["docker","image","inspect",os.environ["NEW_IMAGE_ID"]],text=True))[0]
    expected=dict(item.split("=",1) for item in image_config["Config"].get("Env",[]) if "=" in item); expected.update(desired)
    if current!=expected: raise ValueError()
    if not any(str(p.get("published"))=="8080" and str(p.get("target"))=="8080" and p.get("host_ip")=="10.0.0.11" for p in service.get("ports",[])): raise ValueError()
    mounts=inspect.get("Mounts",[])
    if not any(m.get("Name")=="smart-tv_settings" and m.get("Destination")=="/app/state" and not m.get("RW") for m in mounts): raise ValueError()
    wanted={"/run/settings-secrets/wrapping.crt","/run/settings-secrets/wrapping.key"}
    desired_mounts={m.get("target"):m for m in service.get("volumes",[])}
    current_mounts={m.get("Destination"):m for m in mounts}
    for target in wanted:
        d=desired_mounts[target]; c=current_mounts[target]
        if d.get("type")!="bind" or not d.get("read_only") or c.get("Source")!=d.get("source") or c.get("RW"): raise ValueError()
except Exception:
    print("deploy: runtime configuration changed or cannot be validated",file=sys.stderr); sys.exit(1)
'; then exit 64; fi
new_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$new_ref") || exit 64
new_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$new_ref") || exit 64
remote_platform=$(docker info --format '{{.OSType}}/{{.Architecture}}') || exit 64
[[ $new_platform == "$remote_platform" ]] || { echo 'deploy: transferred image platform mismatch' >&2; exit 65; }
[[ $new_revision == "$sha" ]] || { echo 'deploy: transferred image revision label mismatch' >&2; exit 65; }
old_id=$(docker inspect --format '{{.Image}}' "$container") || exit 66
old_short=${old_id#sha256:}; old_short=${old_short:0:12}
other_containers=$(docker ps --filter 'label=com.docker.compose.project=smart-tv' --format '{{.ID}} {{.Names}}' | awk -v target="$container" '$2 != target {print $1 ":" $2}' | sort)
override=$(mktemp /tmp/smart-tv-dashboard-image.XXXXXX.yaml)
log=$(mktemp /tmp/smart-tv-dashboard-compose.XXXXXX.log)
cleanup() { rm -f -- "$override" "$log"; }
trap cleanup EXIT
write_override() { printf 'services:\n  dashboard:\n    image: "%s"\n' "$1" >"$override"; chmod 600 "$override"; }
compose_deploy() { compose -f "$dir/compose.yaml" -f "$dir/compose.settings.yaml" -f "$override" "$@"; }
health_check() {
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl --fail --silent --connect-timeout 2 --max-time 3 --output /dev/null "$health_url"; then return 0; fi
    sleep 1
  done
  return 1
}
write_override "$new_ref"
deployment_reason='Compose recreation failed'
deployment_health='not checked'
if compose_deploy up -d --no-build --no-deps dashboard >"$log" 2>&1; then
  deployment_reason='health check failed'
  deployment_health='unhealthy or timed out'
  if health_check; then
    deployment_health='healthy'
    deployment_reason='dashboard image did not match the requested revision'
    if [[ $(docker inspect --format '{{.Image}}' "$container") == "$new_id" ]]; then
      deployment_reason='another smart-tv service changed unexpectedly'
      if [[ $(docker ps --filter 'label=com.docker.compose.project=smart-tv' --format '{{.ID}} {{.Names}}' | awk -v target="$container" '$2 != target {print $1 ":" $2}' | sort) == "$other_containers" ]]; then
  printf 'Deployment SHA: %s\nHealth: healthy at %s\n' "$sha" "$health_url"
  exit 0
      fi
    fi
  fi
fi
printf 'Deployment SHA: %s\nHealth: %s at %s\nDeployment: failed (%s)\n' "$sha" "$deployment_health" "$health_url" "$deployment_reason"
rollback_ref="$image:rollback-${old_short}-$(date +%s)-$$"
while docker image inspect "$rollback_ref" >/dev/null 2>&1; do rollback_ref="${rollback_ref}-x"; done
rollback_status='not attempted'
if docker tag "$old_id" "$rollback_ref" >/dev/null 2>&1; then
  write_override "$rollback_ref"
  rollback_status='Compose recreation failed'
  if compose_deploy up -d --no-build --no-deps dashboard >"$log" 2>&1; then
    rollback_status='health check failed'
    if health_check; then
      rollback_status='previous image was not restored'
      if [[ $(docker inspect --format '{{.Image}}' "$container") == "$old_id" ]]; then rollback_status=healthy; fi
    fi
  fi
fi
other_services_after=$(docker ps --filter 'label=com.docker.compose.project=smart-tv' --format '{{.ID}} {{.Names}}' | awk -v target="$container" '$2 != target {print $1 ":" $2}' | sort)
if [[ $other_services_after == "$other_containers" ]]; then other_services_status=unchanged; else other_services_status=changed; fi
printf 'Rollback dashboard: %s (previous image %s)\nOther smart-tv services: %s\n' "$rollback_status" "$old_short" "$other_services_status"
if [[ $rollback_status == healthy ]]; then
  echo 'Deployment outcome: failed; rollback restored the previous dashboard image and health checks passed.'
  [[ $other_services_status == unchanged ]] || echo 'Service preservation: another smart-tv service changed during this operation; investigate it separately.' >&2
else
  echo 'Deployment outcome: failed; rollback did not confirm the previous dashboard image healthy. Manual recovery is required.' >&2
fi
exit 1
REMOTE_DEPLOY
then
  exit 0
else
  die "deployment or rollback failed; inspect production health at $HEALTH_URL"
fi
