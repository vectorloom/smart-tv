# Still — Smart TV photo dashboard

Milestones 1–3 provide a React + TypeScript gallery and fullscreen photo slideshow backed by an ASP.NET Core 10 Web API. The dark interface targets a 1920×1080 TV, with responsive layouts for smaller screens. The independent Docker Compose project is named `smart-tv`.

## Current status

Implemented: selected albums, paginated photo discovery, lazy thumbnails, fullscreen slideshow, play/pause, previous/next, interval selection, shuffle, adjacent-image preloading, keyboard navigation, and safe error/empty states. Videos are excluded. Album metadata is fully loaded before starting playback, so shuffle includes every discovered photo. The grid renders 60 photos at a time with a **Show more** control.

Milestone 1 is deployed and working. Milestone 2 adds TV navigation and the paired phone remote. Milestone 3 adds an isolated administrator settings interface and encrypted persistent settings; deployment remains subject to explicit approval. No Docker rebuild or redeployment was performed for Milestone 2, no existing service configuration was changed, and no existing credentials were read. Validation uses synthetic photos.

## Immich API contract

The installed server's public `GET /api/server/version` endpoint reported **3.1.0** during discovery on 2026-09-17. Implementation follows the official, version-pinned [v3.1.0 OpenAPI schema](https://github.com/immich-app/immich/blob/v3.1.0/open-api/immich-openapi-specs.json), rather than the moving latest documentation.

| Operation | Upstream request | Key permission |
| --- | --- | --- |
| List available albums, then filter configured IDs | `GET /api/albums` | `album.read` |
| Read album photos and verify photo membership | `POST /api/search/metadata` | `asset.read` |
| Thumbnails and slideshow previews | `GET /api/assets/{id}/thumbnail?size=thumbnail` or `size=preview` | `asset.view` |

In this version, `AlbumResponseDto` does **not** contain an `assets` array. The client searches using `albumIds`, `type: IMAGE`, `page`, `size`, and ascending order. It reads `assets.items` and the nullable string `assets.nextPage`. Image requests also search by asset `id` and album ID before fetching bytes. The POST search is a read operation; this application does not call any Immich mutation API.

The server sends the key in the `x-api-key` header. Only `thumbnail` and `preview` sizes are permitted. Original/fullsize downloads and their additional permissions are unnecessary. Upstream redirects are disabled so credentials cannot follow a redirect to another host. After an Immich upgrade, check the matching OpenAPI contract and rerun the adapter tests before relying on compatibility.

## Administrator settings (Milestone 3)

The administrator interface is separate from the TV/remote listener. Read the
[certificate and Windows trust plan](docs/administrator-tls.md), then the
[deployment, migration, backup, and tested recovery guide](docs/settings-operations.md).
For the local-build, SSH image-transfer deployment workflow, see
[Dashboard deployment](docs/deployment.md).
The intended Windows URL is `https://localhost:18443/settings` through an existing
SSH tunnel. There is no default password, unauthenticated setup API, or certificate
warning bypass. No production certificates or administrator credentials were
created during implementation.

The opt-in `compose.settings.yaml` overlay adds the loopback-only administrator
service and `smart-tv_settings` volume. API keys are protected with ASP.NET Core
Data Protection; the key ring is certificate-encrypted, with the private wrapping
key kept outside the volume. New keys are write-only and validated against the
actual Immich version, album/search endpoints, and thumbnails before an atomic
save. Owned/shared albums can be selected without restarting the TV container.

Persisted configuration takes precedence over environment configuration. With no
persisted file, the original environment path remains active. Import is an explicit,
authenticated, server-side operation; corrupt/undecryptable settings never silently
fall back to older environment credentials. The operator guide covers both lost
administrator credentials and lost wrapping certificates while preserving album
selections where possible.

## Configuration

Create a **dedicated API key** through an ordinary Immich user's account settings. Enable only `album.read`, `asset.read`, and `asset.view`. The user must own or have read access to the selected albums. A separate non-administrator user with access only to the intended albums further limits what the key can read. Do not use an administrator key or enable all permissions.

Copy `.env.example` to `.env` locally and replace placeholders. `.env` is excluded from Git and Docker build context. Never put keys in frontend code, `VITE_*` variables, URLs, screenshots, logs, or commits.

| Compose variable | ASP.NET environment variable for local development | Meaning |
| --- | --- | --- |
| `IMMICH_URL` | `Immich__BaseUrl` | Immich API root, ending in `/api/` |
| `IMMICH_API_KEY` | `Immich__ApiKey` | Dedicated read-only key |
| `IMMICH_ALBUM_IDS` | `Immich__AlbumIds` | Comma-separated album UUIDs from Immich album URLs |
| `SMART_TV_BIND` | N/A | Host address for application port 8080; default `127.0.0.1` |
| `WEATHER_LATITUDE` | `Weather__Latitude` | Forecast latitude; defaults to Dallas, Texas (`32.7767`) |
| `WEATHER_LONGITUDE` | `Weather__Longitude` | Forecast longitude; defaults to Dallas, Texas (`-96.7970`) |
| N/A | `Weather__CacheFile` | Last good forecast file; the image defaults to `/app/data/weather.json` on the data volume, local runs to the temp directory |
| N/A | `Remote__SessionFile` | Paired remote sessions (hashed credentials and expiry); the image defaults to `/app/data/remote-sessions.json`, local runs to the temp directory |

Weather uses the server-side Open-Meteo forecast API and needs no API key. The TV
calls only the same-origin `/api/weather` endpoint. Coordinates use decimal WGS84
degrees; the default is central Dallas. Forecasts use Fahrenheit and the
`America/Chicago` timezone. The backend caches successful results for 20 minutes.
If Open-Meteo fails, it serves the last good forecast with `stale: true` and the time
it was fetched, and logs the failure reason. The last good forecast is also written to
`Weather__CacheFile`, so a restarted or redeployed API can serve it (for up to a day)
before Open-Meteo answers again. In the container it lives on the `smart-tv_data`
volume (see [docs/deployment.md](docs/deployment.md#data-volume-runtime-state)). With nothing
cached, a failed request is retried after 15 seconds rather than one minute.

The TV refreshes weather every seven minutes. After a failure it retries after 5, 10,
20 and 30 seconds, then every minute, and immediately when the browser comes back online.
It also keeps the last forecast it saw in `localStorage` (up to a day old) and shows it,
marked "offline" with its update time, until the API answers. While no forecast is
available, every weather slot keeps its place with muted placeholders. Weather failures
do not affect gallery requests.

An empty album selection exposes no albums. Invalid IDs fail configuration validation without echoing their values. Missing keys produce an actionable 503 error on data requests. The health endpoint only verifies the dashboard process, not Immich access.

For Compose, `http://host.docker.internal:2283/api/` reaches Immich's existing published host port through a host-gateway alias. The dashboard gets its own default Compose network and does not join any existing network or project. Environment-only mode has no persistent volumes. The optional Milestone 3 settings overlay adds a project-specific settings volume, mounted read-only by the TV service. Its container runs as the .NET image's unprivileged application user, with a read-only root filesystem and a small `/tmp` tmpfs.

The default loopback binding is not reachable from the TV. Keep `SMART_TV_BIND` unchanged for this milestone; LAN access needs separate approval as described below. Do not use `0.0.0.0` or `::` by default. The dashboard has no user login: anyone able to reach its port can view the selected photos. Do not expose it to the public internet. Image responses use a private 60-second browser cache for preloading. The server also keeps proxied thumbnails and previews in a size-limited memory cache (`ImageCache__LimitMegabytes`, default 200 MB) for 30 minutes, and per-album photo lists for the home slideshow for 30 minutes. A cache hit still enforces the album selection, but a photo removed from an album in Immich can remain viewable for up to 30 minutes.

## Local development

Prerequisites: Node.js 24 with npm, and .NET SDK 10. The approved validation environment has a workspace-local SDK at `.local/dotnet/dotnet`; it does not alter the system installation. All optional caches and artifacts under `.local/` are ignored.

From the project root, prepare project-local tool paths for the current shell:

```bash
export DOTNET_ROOT="$PWD/.local/dotnet"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_HOME="$PWD/.local"
export NUGET_PACKAGES="$PWD/.local/nuget"
export TMPDIR="$PWD/.local/tmp"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
mkdir -p "$TMPDIR"
```

If using an already installed SDK instead, omit `DOTNET_ROOT` and the PATH change. Dependency installation writes only project-specific files:

```bash
npm ci --prefix src/web --cache "$PWD/.local/npm"
dotnet restore tests/api/SmartTv.Api.Tests.csproj
```

Configure the API in its terminal. Use a hidden prompt to avoid putting the key in command history:

```bash
export Immich__BaseUrl=http://127.0.0.1:2283/api/
export Immich__AlbumIds=REPLACE_WITH_SELECTED_ALBUM_UUIDS
read -rs -p 'Dedicated Immich read-only API key: ' Immich__ApiKey
export Immich__ApiKey
dotnet run --no-launch-profile --project src/api --urls http://127.0.0.1:5080
```

The API does not automatically load the Compose `.env` file. Start the frontend in another terminal:

```bash
npm run dev --prefix src/web
```

Open `http://127.0.0.1:5173`. Vite proxies HTTP and WebSocket `/api` requests to loopback port 5080, keeping the browser on one origin. Both development servers bind to loopback. No CORS exception or browser-side Immich credential is needed.

## TV controls

| Context | Controls |
| --- | --- |
| Any screen | Arrow keys move focus spatially; Enter or Space activates; Escape, Backspace or the browser/remote Back button goes back through history (on a deep link, one level up); Home goes to the home screen |
| Navigation rail | Left from the leftmost item on a screen enters the rail; Up/Down moves; Right returns to the screen where you left it; Enter opens the screen |
| Slideshow stage | Left/Right changes photo; Enter or Space toggles playback; Up/Down moves focus to controls |
| Slideshow controls | Arrows move focus; Enter activates; Space toggles playback; the interval selector keeps native keyboard behavior (Tab/Shift+Tab leaves it) |
| Slideshow (outside inputs) | Escape/Backspace exits; Home returns to albums; Tab/Shift+Tab cycle only within the slideshow |

Playback waits for the image to load before starting its interval. Failed images show an error and advance on the selected interval when playing. Previous/next wrap around; shuffle preserves the current photo and provides a stable shuffled sequence until toggled. The current interval defaults to eight seconds and is adjustable to 3, 5, 8, 15, 30, or 60 seconds. Settings reset for a new slideshow.

A mouse works the same way: clicking a button is the same as Enter, and moving the mouse wakes the home screen like a key press. Keys keep working after a click elsewhere on the page (for example on the letterbox bars).

The browser Fullscreen API is requested directly from the activation gesture. If unsupported or denied, a viewport-filling overlay remains usable. Escape or the Exit button closes the slideshow and restores focus to the launching control. Actual TV browser compatibility should be checked on the target device, including its fullscreen and remote-key behavior.


## Screens

| Route | Screen |
| --- | --- |
| `/` | Home: photo slideshow, clock and weather |
| `/photos` | Photos: one horizontal row per album (first 12 photos and **See all**), at most 20 rows; further albums are listed as buttons. Only rows within two of the focused row load thumbnails |
| `/photos/:albumId` | Album: every photo, **Play album**; `?photo=<id>` opens the full-screen viewer |
| `/weather` | Current conditions, next 12 hours, 7 days and the regional wind map |
| `/home-automation` | Placeholder until Home Assistant is connected |
| `/calendar` | Placeholder until a calendar is connected |
| `/preferences` | Settings (rail label): phone pairing and display details |

A navigation rail on the left links the screens. On home it is hidden and slides in, expanded, on the first key press, then hides after 30 seconds without input. With a mouse it opens when the pointer reaches the left edge and closes about 1.5 seconds after the pointer leaves it (or leaves the window); moving the mouse over the photo only shows the album buttons. Choosing an item closes it. On other screens it stays collapsed to 112 px icons and expands while it has focus. The viewer is a URL, so Back, Escape and the browser's back button all close it and return focus to the photo that opened it; focus is remembered per history entry and restored on Back.

### Home screen

The home screen never scrolls. A random photo from the selected albums fills the left side and crossfades every 30 seconds. Albums are weighted by the square root of their size, so a 1,000-photo album appears about 3× as often as a 100-photo album. The next photo is decoded in the browser before the change, and the server prefetches the one after it. When idle, only an **All albums (N)** button sits on the photo. The first key press (or mouse movement) shows the rail and, for up to eight albums, a single row of album buttons above the caption; both hide again after 30 seconds without input. The right rail shows the clock, current weather, a 12-hour temperature chart and a 5-day forecast. Nothing is focused until the first key press.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/slideshow/next` | Next random photo: album, photo ID, `takenAt`, and position (`index` of `total`); 204 when no selected album has photos |

## Phone remote and pairing (Milestone 2)

1. On the TV, open **Settings** in the navigation rail (`/preferences`) and select **Pair phone**. The TV displays an eight-digit code for two minutes. **New pairing code** invalidates the previous code.
2. Open `/remote` on the same application origin in a second tab or browser context; enter the code and choose **Pair with TV**. For local development use `http://127.0.0.1:5173/remote`. A second tab simulates the phone without LAN access.
3. Use the D-pad and Select to navigate. Back leaves the slideshow or album; Home returns to albums. Play/Pause starts the open album or toggles playback; Next/Previous change slideshow photos even during image loading. In slideshow controls, arrows move focus; on the interval selector, the phone's Up/Down changes its value and Left/Right leaves it.
4. The phone can **Unpair phone**; the TV can **Unpair this TV** (Settings). The TV can issue another code to replace its paired phone. Pairing a new phone revokes the previous phone immediately.

The TV and phone display connection state. Commands are disabled on the phone while disconnected. Both ends reconnect automatically (500 ms initial delay, exponential backoff capped at 10 seconds), with a heartbeat every 15 seconds. The browser closes a connection without a response for 40 seconds; the server limits idle receives to 45 seconds. Commands during disconnection are not queued or replayed. Reconnection resumes the same dashboard session. Each page keeps its credential in `localStorage` (`still.remote.tv` / `still.remote.phone`), so reloading either page or power-cycling the TV keeps the pairing. A paired session expires after 30 days without either side reconnecting; each reconnect renews it. Paired sessions are saved to `Remote__SessionFile` as SHA-256 hashes of the two credentials plus the expiry, so they survive a backend restart or redeploy; the server never stores a raw credential. An unpaired TV session keeps the original limits (two minutes offline or 12 hours in total) and is never saved. **Unpair this TV** on the TV's Settings screen (pressed twice to confirm) ends the TV's session, revokes the phone and removes the saved session; the TV then starts a fresh one. Each WebSocket connection logs its address and User-Agent once (printable ASCII, at most 256 characters), which identifies the TV box's browser.

Each dashboard receives a separate 256-bit cryptographically random owner credential. Tabs on the same origin share `localStorage`; if a second TV tab resumes the stored session, the server sends the previous tab `replaced` and it starts a fresh, unstored session, so tabs never fight over one session. Only a tab whose stored credential matches its own, or that has just paired, writes to storage. A successful code exchange issues a separate 256-bit phone credential scoped to exactly that dashboard. One phone session is active per dashboard. Codes use `RandomNumberGenerator.GetInt32`, are single-use and expire after two minutes. Registration, pairing, and resume attempts share a limit of 20 per source IP per minute, across connections. WebSocket upgrades are limited to 60 per IP per minute, messages to 30 per connection per second, active sessions to 1,000, incoming messages to less than 1 KiB, and outgoing queues to 32 messages. Slow peers disconnect. Limits deliberately include failed attempts. On a shared proxy, clients share the proxy's IP budget; no untrusted forwarded-address header is used.

### WebSocket architecture

ASP.NET Core's built-in WebSocket endpoint is `/api/remote`; no SignalR client or additional dependency is required. It is same-origin, with exact `Origin` validation against the request scheme and host and no cross-origin opt-in. Vite proxies WebSocket upgrades during development. Production serves the compiled React app and endpoint from the same ASP.NET process. State is held in a locked, in-memory broker, with one bounded outgoing channel and one socket writer per connection. A periodic sweep expires codes and sessions. This is a single-instance design; multi-instance deployments would need a shared broker and session store.

All protocol messages are JSON **text frames**, never URL parameters:

| Client message | Authorization and result |
| --- | --- |
| `register` | Creates a dashboard session; `ready` returns its owner credential |
| `code` | Owner only; returns `code` and UTC `expires` |
| `pair` with `code` | Exchanges a valid TV code for a phone credential in `ready` |
| `resume` with `credential` | Reattaches the corresponding TV or phone connection |
| `command` with `command` | Paired phone only; forwards to its own connected TV |
| `unpair` | Owner or paired phone; revokes phone credential and outstanding code |
| `ping` | Returns `pong`; does not authorize commands |

The server accepts only `Up`, `Down`, `Left`, `Right`, `Select`, `Back`, `Home`, `PlayPause`, `Next`, and `Previous`. It returns `status`, `error`, `denied`, `codeExpired`, `expired`, or `revoked` updates as appropriate. Unauthorized commands are rejected before delivery. Commands are transient, best-effort delivery; there is no persisted queue or exactly-once acknowledgement. The UI does not retry commands after a transport interruption.

Credentials exist in browser memory and `localStorage` (see above); the server keeps only their SHA-256 hashes, in memory and in the session file. They are never in URLs, cookies, or application logs. Anyone with access to the TV browser's site data can control that TV until it is unpaired. There is no shared-tab credential and no frontend Immich key. Do not enable WebSocket payload logging or capture production pairing/session frames in traces. Pairing authorizes control only: photo viewing remains accessible to anyone who can reach the dashboard, as in Milestone 1.

### Future LAN-only access — not enabled

The Compose default remains **127.0.0.1:8080**. A real phone cannot reach the host's loopback address; use a second browser tab for now. After separate approval, a future LAN deployment could set the existing `SMART_TV_BIND` variable to the host's specific private Wi-Fi/LAN address, retaining the independent `smart-tv` project and port 8080. Both TV and phone would open that host address, with the phone at `/remote`. Do not bind all interfaces or create router port forwards. No firewall, Caddy, SSH, Immich, or other service changes are part of this milestone.

Only use a trusted private network. Plain HTTP/WS provides no transport confidentiality: a network observer could capture photos, codes, and credentials and take over a session. Prefer a separately reviewed HTTPS/WSS setup with trusted certificates before enabling LAN access; any future reverse proxy must preserve the intended host/scheme for Origin validation and support WebSocket upgrades. Pairing is not gallery authentication, and LAN access exposes selected photos to reachable clients. Public internet exposure is unsupported.

TV screens are laid out on a fixed 1920×1080 canvas that is scaled uniformly to the browser's viewport (Android TV browsers often report 1280×720 or 960×540), with persistent amber focus rings for keyboard and phone actions. Geometry-based arrow navigation is deterministic for the rendered grid, keeps focus at boundaries, and excludes disabled controls. Enter/Space activates gallery buttons; inputs and editable fields retain native keyboard handling. Returning from the viewer restores its launching photo; returning from an album restores the button that opened it. Loading, retry, and empty views retain an available navigation control. The stage scale is recomputed on every viewport change (resize, fullscreen, zoom), and non-16:9 windows are letterboxed in the background colour.

## Testing and builds

With the project-local environment above:

```bash
dotnet test tests/api/SmartTv.Api.Tests.csproj --no-restore
npm test --prefix src/web
npm run build --prefix src/web
dotnet publish src/api/SmartTv.Api.csproj --no-restore -c Release -o .local/publish
```

API unit tests use an in-memory HTTP handler with synthetic v3.1.0 response fields. They check request construction, minimum data mapping, pagination, album restrictions, asset membership, supported media sizes, and safe upstream failures. React tests cover navigation, wraparound, shuffle, timing, pause/resume, interval changes, focus containment, and failed images.

Browser tests start dedicated loopback Vite/API servers plus an isolated HTTPS settings fixture and use synthetic albums and image responses without talking to Immich. Stop local development servers first; tests refuse to reuse them. Build the frontend with `npm run build --prefix src/web`, then run `bash scripts/build-test-host.sh` to prepare the Debug API and synthetic settings host without downloads; servers use existing build outputs. The default Playwright command uses the project-local SDK described above. If using a system SDK, change that command to your SDK path. No browser or package download is automatic. If Chromium is installed:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser --prefix src/web
```

Otherwise, a project-local Playwright browser can be downloaded with approval:

```bash
cd src/web
PLAYWRIGHT_BROWSERS_PATH=../../.local/playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=../../.local/playwright npm run test:browser
```

Do not use `playwright install --with-deps` on this host; it installs system packages. Browser tests verify TV-sized keyboard operation and mobile overflow. They also use two independent browser contexts against the real WebSocket endpoint to verify pairing, command delivery, tab isolation, transport reconnection, and unpairing. A longevity test runs about 200 home-slideshow crossfades and 200 viewer advances and checks that the DOM size, live image objects (after garbage collection) and object URLs stay flat. Every screen, including the full-screen viewer with its controls, is checked for text below 16 px. API tests cover expiry, rate limits, authorization, malformed messages, credential revocation, session persistence, and disconnected delivery. Their screenshots and reports are ignored build artifacts.

Tests tagged `@perf` (the wind map's frame rate) measure the machine as much as the code, so `scripts/deploy.sh` skips them with `--grep-invert @perf`. A plain run still includes them; after changing the wind map, run `bash scripts/test-browser.sh --grep @perf` on a machine that isn't hot or power-throttled.

## Deployment

See [the deployment guide](docs/deployment.md) for prerequisites and the
dashboard-only SSH image-transfer workflow. Check a reviewed revision locally
without connecting to production:

```bash
scripts/deploy.sh --dry-run "$(git rev-parse HEAD)"
```

Run the read-only production preflight without building or deploying:

```bash
scripts/deploy.sh --preflight-only "$(git rev-parse HEAD)"
```

Deploy only after reviewing the clean checkout and full commit SHA:

```bash
scripts/deploy.sh <full-commit-sha>
```

## Files

```text
src/api/                  ASP.NET routes, validated configuration, Immich adapter
src/web/src/              React TV shell (routes, rail, focus zones), screens, viewer, styles, unit tests
src/web/e2e/              Browser tests using synthetic photos
tests/api/                Adapter unit tests
Dockerfile                Multi-stage frontend/backend build
compose.yaml              Independent smart-tv project, loopback binding
.env.example              Placeholders and non-secret configuration defaults
docs/validation.md        Validation results and remaining checks
```
