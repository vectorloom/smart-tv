#!/usr/bin/env bash

normalize_platform() {
  local value=${1-} os architecture extra
  [[ $value =~ ^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || return 2
  IFS=/ read -r os architecture extra <<<"$value"
  case "$architecture" in
    x86_64) architecture=amd64 ;;
    aarch64) architecture=arm64 ;;
  esac
  printf '%s/%s\n' "$os" "$architecture"
}

platforms_equal() {
  local left right
  left=$(normalize_platform "${1-}") || return 2
  right=$(normalize_platform "${2-}") || return 2
  [[ $left == "$right" ]]
}
