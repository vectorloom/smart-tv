#!/usr/bin/env bash
set -Eeuo pipefail

# Production's dashboard must remain bound only to its known LAN address.
readonly expected='10.0.0.11'
candidate=${1-}
[[ $candidate == "$expected" ]] || {
  echo 'deploy: production bind address is missing or does not match the approved address' >&2
  exit 1
}
printf '%s\n' "$candidate"
