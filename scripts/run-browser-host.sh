#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
export DOTNET_ROOT="$PWD/.local/dotnet"
export DOTNET_CLI_HOME="$PWD/.local"
export TMPDIR="$PWD/.local/tmp"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
exec .local/dotnet/dotnet tests/browser-host/bin/Debug/net10.0/SmartTv.BrowserHost.dll "$PWD"
