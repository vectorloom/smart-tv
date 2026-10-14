# Milestone 1 validation

Validated on 2026-09-17 in `/home/lazyboy/projects/smart-tv`.

| Check | Result |
| --- | --- |
| Installed Immich version | Public version endpoint returned 3.1.0 |
| API contract | Read the official v3.1.0 OpenAPI schema before implementing requests and DTO mapping |
| API adapter unit tests | 17 passed, using synthetic responses and an in-memory HTTP handler |
| React/navigation unit tests | 10 passed |
| Browser tests | 2 passed in installed Chromium: 1920×1080 navigation/slideshow/focus restoration and 390px mobile overflow |
| Frontend production build | TypeScript check and Vite build passed |
| Backend Release publish | Passed with project-local .NET SDK 10.0.401 |
| Compose validation | `docker compose --env-file .env.example config --quiet` passed without displaying configuration values |
| Visual inspection | Reviewed the 1920×1080 gallery screenshot generated from synthetic test images |

Frontend dependencies are locked in `src/web/package-lock.json`. Approved downloads, SDK, dependency caches, temporary browser profiles, and build artifacts are confined to the project. No system packages were installed.

## Remaining checks

- **Live Immich integration:** not run with authentication. A dedicated non-administrator key with `album.read`, `asset.read`, and `asset.view`, plus selected album IDs, must be configured locally. No existing service credentials or environment values were inspected.
- **Physical TV:** verify the actual browser's fullscreen behavior, image decoding, remote key events, and viewing-distance readability.
- **Container build and deployment:** intentionally not run. The Dockerfile has not been exercised as a Docker build; its frontend build and backend publish steps were exercised directly. Deployment requires separate approval.
- **Large libraries:** photo metadata is fetched page by page before slideshow launch; unusually large albums may take longer to open. Thumbnails are lazy-loaded and the visible grid is chunked.

Existing Docker containers, images, networks, volumes, and Compose projects were not changed. No firewall, SSH, Caddy, or other host configuration was changed. Temporary browser-test servers terminate when the tests complete.


# Milestone 2 validation

Validated on 2026-09-18, using installed dependencies and synthetic gallery data. Milestone 1 remains deployed; Milestone 2 has not been deployed.

| Check | Result |
| --- | --- |
| API unit tests | **24 passed**: existing 17 Immich adapter tests plus 7 pairing/security/session tests |
| React/navigation unit tests | **18 passed**, including slideshow load/decode timeout and late-completion regressions, keyboard navigation, input handling, focus restoration, empty albums, and retry |
| Chromium browser tests | **6 passed**, including two separate browser contexts against the real WebSocket broker, second-TV-tab isolation, command delivery, both-end reconnection, TV/phone unpair, native interval changes via phone, unauthorized commands, and foreign-origin rejection |
| Existing browser regressions | Passed: missed third-image load notification, slow-image timeout, manual Next/Previous during loading, five-image playback, fullscreen/focus return, and mobile overflow |
| Frontend production build | TypeScript check and Vite build passed; output `src/web/dist/` |
| Backend production build | Release publish passed; output `.local/publish-m2/` |
| Visual review | Reviewed synthetic gallery screenshot at 1920×1080; persistent focus ring, enlarged labels, and large control targets |
| Deployment/network settings | `compose.yaml` and `Dockerfile` unchanged; loopback default remains `127.0.0.1:8080` |

No dependency downloads, Docker operations, live Immich requests, secret inspection, or changes to other projects/services were performed. The sandbox blocks local sockets, so test-runner/browser server access was explicitly approved. Playwright starts its own loopback API/Vite processes and stops them after testing. A Vite ECONNRESET warning occurred during deliberate transport disconnect/teardown; all reconnection and browser assertions passed. No credential-bearing frames are logged or saved by the tests.

Remaining deployment checks: obtain deployment approval, then verify on the physical TV and, only after separate LAN-access approval, a real phone on trusted Wi-Fi. HTTPS/WSS and gallery-access implications are documented in README.md. The broker is in-memory and single-instance; restarting the backend requires re-pairing. Browser fullscreen requests from phone commands may be denied by the browser's local-gesture policy; the existing full-viewport slideshow overlay still works.
