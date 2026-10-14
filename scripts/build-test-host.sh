#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
export DOTNET_ROOT="$PWD/.local/dotnet"
export DOTNET_CLI_HOME="$PWD/.local"
export NUGET_PACKAGES="$PWD/.local/nuget"
export TMPDIR="$PWD/.local/tmp"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
# Local source only; cannot download a dependency.
.local/dotnet/dotnet restore tests/browser-host/SmartTv.BrowserHost.csproj --source "$PWD/.local/nuget"
.local/dotnet/dotnet build tests/browser-host/SmartTv.BrowserHost.csproj --no-restore
