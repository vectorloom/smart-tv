# Dashboard deployment

`scripts/deploy.sh <full-commit-sha>` builds the dashboard image on the local
machine, streams only that image to `lazyboy@10.0.0.11`, and asks Compose in
`/home/lazyboy/projects/smart-tv` to recreate only `dashboard`. It requires the
local checkout to be clean and the requested 40-character revision to equal
`HEAD`. The image carries the revision in both its tag and
`org.opencontainers.image.revision` label.

## Prerequisites

- Run from a checkout with Docker, Node/npm, the project-local .NET SDK and
  dependencies, Chromium, and SSH available. The local Docker daemon must allow
  image builds and saves.
- Configure SSH key authentication and host-key verification for
  `lazyboy@10.0.0.11`; the script uses batch mode and does not prompt for a
  password or accept a new host key automatically.
- Production must have Docker Compose, `curl`, `python3`, and the standard shell
  utilities used by the script. The script supplies the known non-secret
  `SMART_TV_IMMICH_ADDRESSES=10.0.0.11` and validated
  `SMART_TV_BIND=10.0.0.11` values directly to each isolated Compose invocation.
  The bind address is checked against the approved production address before
  preflight and again remotely before deployment. Other Compose interpolation
  must resolve from Compose's project `.env` context or its declared defaults;
  interactive shell exports are intentionally not inherited. The script does
  not pass an `--env-file` or use the protected backup as configuration.
- The dashboard must be running as `smart-tv-dashboard-1` under project
  `smart-tv`, with the expected Compose file labels, published address, protected
  runtime configuration, `smart-tv_settings` mount, and read-only certificate
  mounts. The remote platform must match the locally built image platform.

The read-only preflight renders Compose configuration in memory, compares its
dashboard environment and mounts with the running container, and confirms the
resolved Compose image reference matches the running dashboard image. It checks
the dashboard-specific Compose image ID against the running container and
confirms the running image reference appears in the resolved Compose image list.
It emits no expanded configuration or environment values. If these checks
cannot identify the dashboard image unambiguously, it stops. It obtains the remote
Docker platform and verifies the local image platform before transfer. If
Compose interpolation cannot be resolved from the known export and the existing
project context, or if the resolved runtime/image cannot be matched to the
running dashboard, the script stops before transferring the image. It also
refuses to overwrite an existing remote image tag for the requested SHA. Do not
loosen these checks by copying the protected backup into the checkout.

The previous deployment wrapper cleared the remote environment and supplied
only `SMART_TV_IMMICH_ADDRESSES`; this caused `SMART_TV_BIND` to fall back to
Compose's `127.0.0.1` default even though the running dashboard is intended to
bind `10.0.0.11`. The deployment wrapper now supplies the approved bind address
consistently for preflight, recreation, and rollback.

## Safe use

First confirm the revision and review the pending changes locally:

```bash
git status --short --branch
git rev-parse HEAD
scripts/deploy.sh --dry-run "$(git rev-parse HEAD)"
```

Dry-run validates the local clean checkout and revision and prints the planned
operations. It does not run tests, build an image, connect to production, or
change production. To deploy, use the full reviewed SHA:

```bash
scripts/deploy.sh <full-commit-sha>
```

To validate production readiness without running application tests or changing
production, use the read-only preflight mode with the reviewed full SHA:

```bash
scripts/deploy.sh --preflight-only "$(git rev-parse HEAD)"
```

This mode validates the local SHA, `HEAD`, clean worktree, and required
repository files, then connects over SSH to run the production Compose/runtime
preflight. It exits immediately after that check. It does not require local
Docker or npm and does not run tests, build/tag/transfer/load an image, recreate
a container, poll deployment health, or attempt rollback. Production checks use
read-only commands (`hostname`, `docker compose config/images`, and Docker
inspection); Compose configuration is processed in memory and never printed.
SSH access is therefore required, but the script does not install or require
Git on production.

The dry-run and preflight-only options are mutually exclusive. Dry-run is local
only and never invokes SSH; preflight-only contacts production but stops before
deployment operations.

The deployment runs the frontend build and unit tests, API tests, browser-host
build, and browser tests before building the Docker image. It performs a
read-only remote preflight before transferring the image. The transfer uses
`docker save` over SSH directly into `docker load`; source files, `.env`,
certificates, and credentials are not transferred. A temporary Compose override
in remote `/tmp` selects the SHA-tagged image without changing either production
Compose file or replacing the prior `latest` image tag.

Only `dashboard` is targeted with `up -d --no-build --no-deps dashboard`. The
script never runs `docker compose down` and compares the IDs of the other running
services in project `smart-tv` before and after deployment. The named settings
volume, certificate mounts, protected environment, and admin service are
expected to remain in place.

Recreating the dashboard causes a short interruption. Phone pairings and the last
good weather forecast survive it when the data volume (below) is mounted; without
it they are kept in memory only and phones must pair again. If startup or the bounded health poll
fails, the script attempts to tag the previous image under a rollback tag and
recreate only `dashboard` with that image. It reports deployment and rollback
health separately. Rollback cannot reverse application data migrations,
external side effects, or a simultaneous host/network/storage failure, and it
does not delete the failed SHA-tagged image. If rollback does not pass health,
manual recovery is required.

The production preflight has not been verified from this development
environment. Before the first deployment, perform a read-only verification that
the remote Compose invocation succeeds with the known exported address and its
existing interpolation context, and that Compose's resolved dashboard image,
environment, bind mounts, volume, published `10.0.0.11:8080` binding, labels,
and CPU architecture match the running container. If that cannot be established,
the script intentionally stops before image transfer; do not supply the protected
backup as `--env-file`.

## Data volume (runtime state)

The image defaults two small state files to `/app/data`:

| File | Setting (image default) | Contents |
| --- | --- | --- |
| `/app/data/weather.json` | `Weather__CacheFile` | Last good Open-Meteo forecast, served (marked stale, with its time) while Open-Meteo is unreachable; ignored after a day |
| `/app/data/remote-sessions.json` | `Remote__SessionFile` | Paired phone-remote sessions: SHA-256 hashes of the TV and phone credentials and the expiry (30 days, sliding on each reconnect). No raw credentials, codes or addresses. Written with mode 0600 |

`compose.yaml` mounts the writable named volume `smart-tv_data` at `/app/data`. The
container root filesystem stays read-only; the image creates `/app/data` owned by the
unprivileged application user, so a new named volume inherits that ownership. The
settings volume stays read-only for the dashboard and is not used for this state.

These defaults are image `ENV` values, not Compose environment entries, so the
deployment script's environment comparison is unaffected. If either file cannot be
written (for example, no volume is mounted and the root filesystem is read-only), the
dashboard logs a warning and keeps the state in memory only.

### One-time production change (requires approval)

`scripts/deploy.sh` never edits the production Compose files. Before or after the
first deployment of an image with these defaults, update
`/home/lazyboy/projects/smart-tv/compose.yaml` on the server to match this
repository (the `data:/app/data` volume entry under `dashboard` and the top-level
`volumes: data:`), then recreate only the dashboard:

```bash
cd /home/lazyboy/projects/smart-tv
docker compose -f compose.yaml -f compose.settings.yaml config --quiet   # validates the merge
docker compose -f compose.yaml -f compose.settings.yaml up -d --no-deps dashboard
```

Use the same `SMART_TV_IMMICH_ADDRESSES` and `SMART_TV_BIND` exports that the
deployment script supplies. The existing preflight checks still require the
`smart-tv_settings` read-only mount and the certificate mounts; the additional data
mount does not affect them. To remove all stored state, stop the dashboard and run
`docker volume rm smart-tv_data`; every phone then pairs again.
