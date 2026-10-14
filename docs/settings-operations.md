# Milestone 3 operator guide — not deployed

All commands below are **future, explicitly approved operations**, not operations
performed during implementation. Do not run `docker compose up`, build, stop, or
recreate anything until deployment is approved. Work only with this project's
Compose files. The deployed Milestone 1/2 service is unaffected by source edits.

## Security and process layout

- The normal dashboard remains on the existing port 8080 with loopback as the
  default host binding. No existing binding, firewall, SSH, Caddy, or Immich changes
  are required. LAN access, if already configured, remains a separate operator choice.
- `compose.settings.yaml` is an **opt-in overlay**. It adds `smart-tv_settings`, a
  dedicated named volume. The TV container mounts it read-only; the optional `admin`
  service mounts it read/write. The base Compose file alone continues to support
  the original environment configuration.
- The administrator service uses the same image/source in administrator-only mode.
  On this Linux host it uses host networking, explicitly binds 127.0.0.1:8443 with
  TLS, and has no published ports. Broad `ASPNETCORE_URLS` cannot broaden that
  listener. Configured Kestrel endpoint overrides are rejected in admin mode.
- Public `/settings` and `/api/admin/*` requests return 404, including requests with
  a valid admin cookie, remote credential, or forged forwarding headers. The admin
  service returns 404 for gallery and remote APIs. No forwarding middleware is
  required; authorization uses the actual socket listener and administrator session,
  not the Docker bridge source address, client IP, or Origin alone.
- Administrator sessions use a separate ASP.NET authentication scheme and protected
  HttpOnly/Secure/SameSite=Strict cookies. Sessions expire after 15 idle minutes or
  8 hours absolute, and are revoked on logout, password reset, or admin process
  restart. At most eight sessions are active. There is no default password, online
  account creation endpoint, URL credential, or use of local/session storage.
- Login: 5 requests/minute; all admin API requests: 240/minute; settings writes:
  10/minute. These are global budgets for one administrator, not spoofable IP budgets.
  Mutations, including login/logout, require same-origin checks **and** ASP.NET
  antiforgery tokens. Authorization remains mandatory for all settings and previews.
- No upstream request/response bodies, passwords, or keys are logged. Error responses
  use fixed messages. Do not enable HTTP payload logging, production browser traces,
  or packet capture for credential-bearing requests.

## Certificate issuance and Windows trust

Read [administrator-tls.md](administrator-tls.md) **before TLS provisioning**.
The exact browser URL is `https://localhost:18443/settings`; the SSH forwarding
command is:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18443:127.0.0.1:8443 user@server
```

Use the project-local .NET SDK or approved published image to generate new material.
For example, after building the Release artifact locally:

```bash
.local/dotnet/dotnet .local/publish-m3/SmartTv.Api.dll provision-material \
  --MaterialDirectory "$PWD/.private/material"
```

This command refuses an existing directory and generates **new** material; it does
not inspect an existing credential. Files: `localhost.crt` and `localhost.key` for
TLS; `wrapping.crt` and `wrapping.key` for settings encryption; `localhost.cer` for
Windows trust. Only the `.cer` file is copied to the laptop. The command uses the
installed .NET cryptography APIs and requires no download.

Before changing ownership, copy the public certificate over authenticated SCP,
verify its SHA-256 file digest at both ends, and trust it explicitly on Windows:

```powershell
scp user@server:/home/lazyboy/projects/smart-tv/.private/material/localhost.cer .\localhost.cer
Get-FileHash .\localhost.cer -Algorithm SHA256
certutil -user -addstore Root .\localhost.cer
```

Compare with `sha256sum .private/material/localhost.cer` on the server. Inspect the
certificate before trusting it. Edge/Chrome must show a valid HTTPS connection;
never click through a certificate warning. If Windows policy blocks user trust,
stop and arrange an organization-issued localhost certificate or approve another
access design. Provisioning and trust-store installation have **not** been performed
for production by this implementation.

The .NET runtime image uses its non-root APP_UID (normally 1654). Verify the built
image's user before provisioning ownership. During approved deployment, set the
material directory to that UID, mode 0700, files 0600. This requires an explicit
host permission change; the app never calls sudo or changes a host trust store.
For UID 1654, the intended commands are:

```bash
sudo chown -R 1654:1654 .private/material
sudo chmod 700 .private/material
sudo chmod 600 .private/material/*
```

The image prepares `/app/state` for the same UID, so a new named volume inherits
appropriate ownership. The application creates settings/key-ring directories with
0700 and settings files with 0600. The TV mounts only the wrapping certificate/key,
not the TLS private key. All secret paths are excluded from Git and Docker context.

## Approve and pin the Immich destination

The UI chooses only among deployment-owned `Immich:Targets` (semicolon-separated
canonical URLs ending in `/api/`). Initially configure only the existing Immich
endpoint, normally `http://host.docker.internal:2283/api/`. User info, query strings,
fragments, non-HTTP(S) schemes, path traversal, and encoded URL tricks are rejected.
Expanding the allowlist is a deployment operation, never a settings-page capability.

Set non-secret `SMART_TV_IMMICH_TARGETS` and `SMART_TV_IMMICH_ADDRESSES` before enabling
the overlay. The latter is a comma-separated list of **exact IPs**, not a private
network range. For the default host-based Immich service it needs the actual
Docker host-gateway IP used by the public container plus 127.0.0.1 for the admin
container. Do not guess the gateway; determine the address from the approved
project's network configuration during deployment. The admin service maps
`host.docker.internal` to 127.0.0.1; the public service retains its existing
host-gateway mapping. This does not change Immich's listener.

Managed mode refuses to start without pinned addresses. Every new outbound socket
resolves the approved host and connects directly to an approved IP; there is no
second DNS resolution in connect. Metadata/link-local, unspecified, and multicast
addresses are rejected, including mapped IPv4 forms. Redirects and outbound HTTP
proxies are disabled. HTTP connects time out after 5 seconds; requests after 30
seconds; complete validation after 60 seconds. JSON responses are capped at 8 MiB;
images retain the existing 32 MiB limit. Environment-only legacy mode permits its
trusted deployment URL without explicit IP pins, but the browser cannot alter it.

## Bootstrap, deploy, and migrate — separate approval required

1. Back up the current project configuration through an existing secure backup
   process. Do not print `.env`, expanded Compose output, or container environment
   values. Do not remove the working environment values yet.
2. Approve the settings overlay, certificate/volume provisioning, and pinned IPs.
   Build the project images only after deployment approval. No other Compose project
   is involved. Use both files for subsequent commands:
   `docker compose -f compose.yaml -f compose.settings.yaml --profile admin …`.
3. Bootstrap the administrator with an interactive terminal. The following starts
   only a one-off CLI, not the administrator web server:

   ```bash
   docker compose -f compose.yaml -f compose.settings.yaml --profile admin \
     run --rm --no-deps admin admin-create
   ```

   Enter a unique 14–256-character passphrase twice at hidden prompts. No passphrase
   may be supplied as a CLI argument or environment variable. Store it in a password
   manager. No default account is created by startup.
4. During the approved deployment window, start/recreate this project's dashboard
   and administrator services using the two Compose files. The named volume is
   initially empty, so the dashboard continues using environment configuration.
5. Establish the Windows SSH tunnel and sign in at the exact HTTPS URL. Verify the
   displayed source is `environment`, and the API key is shown only as configured.
6. Choose **Validate and import environment configuration**. The backend reads its
   already-supplied environment values, validates the installed version, actual
   album/search/thumbnail endpoints, and every selected album, then saves a complete
   encrypted revision. The key never travels back to the browser. Importing is an
   explicit action; startup never automatically copies or overwrites settings.
7. Verify the selected albums on the TV. Retain the secured old environment values
   until this migration and recovery backup are verified. Removing them later is a
   separately reviewed deployment edit; the base Compose no longer requires a key
   variable when persisted settings supply it. Do not rotate the Immich key until
   this app is confirmed to use the new one.

Precedence: persisted settings first; environment **only when settings.json is
absent**. An unreadable, corrupt, unsupported, or undecryptable stored configuration
fails closed; it does not reactivate the old environment key or old album selection.
A missing key after explicit recovery also does not trigger environment fallback.

A replacement is validated against the tested Immich 3.1.x contract (the project
baseline is 3.1.0), owned and shared album listing, album-filtered metadata search,
and an actual thumbnail request. Only `album.read`, `asset.read`, and `asset.view`
are required. Unknown versions or missing permissions fail without saving. If the
first 50 accessible albums have no photo, validation reports incomplete rather than
claiming that thumbnail access was proven. Empty albums can still be selected if
another accessible album supplies a validation photo.

Validation occurs before any settings write. Updates use a revision precondition,
flushed temporary file, and atomic replacement, so a stale editor or failed request
cannot partially change the key/URL/selection. Each subsequent TV request reads the
new revision without a container restart. An already-open gallery should be reloaded
or revisited to refresh its list; a running slideshow is not interrupted by settings
management. Previously downloaded images can remain visible/cached for the existing
60-second cache interval. Unselected IDs remain blocked server-side on new requests.

## Backup and restore

Back up **the complete settings volume**, including `settings.json`,
`administrator.json`, and every `keyring/<generation>/` directory, while the admin
writer is stopped. Put backups on encrypted storage with restricted access.
Separately back up the wrapping certificate **and its private key** using a protected
password manager or encrypted offline medium; do not place them alongside the volume
archive. Protect the TLS private key separately as well. A volume-only backup does
not reveal the Immich key; it also cannot recover it without wrapping material.
Do not use `docker compose down -v` or prune the settings volume.

Restore the volume files into a project-specific volume with the application UID
and original permissions, restore the wrapping material through the protected
read-only mount, and recreate the smart-tv containers during approved maintenance.
The application name and protection purposes remain stable across paths/restarts.
Sessions intentionally do not survive a restart. Re-sign in and verify album access.
Tests copy a complete stored revision/key ring to a different directory and decrypt
it with the original wrapping certificate, in addition to full server restart tests.

Never regenerate wrapping material during ordinary redeployment. For planned
wrapping-certificate replacement, retain the old material for old backups and use
the explicit recovery/re-entry procedure below with a fresh generation. TLS renewal
is independent: copy only `localhost.crt`/`.key`, trust the new public `.cer` on
Windows, and restart the admin service during approved maintenance. Do not overwrite
the wrapping files just because the TLS certificate expired.

## Lost administrator passphrase

This procedure requires host/Docker access through the existing authenticated SSH
account; there is no LAN recovery API.

1. Stop only this project's admin service, preserving the TV service and volume.
2. Run the one-off interactive CLI:

   ```bash
   docker compose -f compose.yaml -f compose.settings.yaml --profile admin \
     run --rm --no-deps admin admin-reset
   ```

3. Enter/confirm the new passphrase at hidden prompts and restart the admin service.
   The password hash and security stamp are replaced; previous sessions are revoked.
   The Immich key and album selections are not changed. This also repairs a damaged
   administrator record. The same reset implementation is tested with a separate CLI
   identity instance while verifying preserved settings and rejected old sessions.

## Lost wrapping certificate/private key

If the original wrapping material exists in a secure backup, restore it first;
this avoids losing the stored Immich key. If it is irretrievably lost, the encrypted
key cannot be recovered. Do not delete settings.json or the volume.

1. Back up the volume as-is and stop the admin writer. The TV may already be unable
   to load new images, but non-secret album selections remain recoverable.
2. Generate fresh material in a **new** directory with `provision-material`. Install
   only its `wrapping.crt` and `wrapping.key` in the protected mount with the app UID
   and 0600 permissions. Keep the existing TLS files so Windows trust is unchanged.
3. Run:

   ```bash
   docker compose -f compose.yaml -f compose.settings.yaml --profile admin \
     run --rm --no-deps admin recover-wrapping
   ```

   The CLI verifies new certificate protection, starts a fresh key-ring generation,
   clears only the unrecoverable encrypted Immich key, and retains the URL and album
   IDs. It does not decrypt or display the lost key and does not fall back to the
   environment key. Old encrypted key rings remain available for old backups.
4. Recreate this project's admin and TV containers during approved maintenance so
   file bind mounts and in-memory certificate caches pick up the new wrapping files.
   Sign in and supply a newly issued/retrieved minimum-permission Immich API key.
   **Validate and save** preserves the recovered album selection if still accessible.
   Remove inaccessible selections only after reviewing them.
5. Back up the new volume and wrapping material separately and verify photo access.

Tests exercise failure with the wrong certificate, recovery with new material,
preservation of selections, a replacement key, and successful decryption after a
fresh store instance. If settings.json itself is corrupt, restore it from backup;
do not guess at or silently discard its album IDs. If there is no usable backup,
explicitly rebuild the selection after host-authorized recovery. No recovery step
modifies Immich, existing Docker projects, firewall, SSH, or Caddy configuration.

## Development and validation

No additional package dependencies were introduced. Run:

```bash
bash scripts/test-api.sh
npm test --prefix src/web
npm run build --prefix src/web
bash scripts/build-test-host.sh
bash scripts/test-browser.sh
```

The test-host restore uses only `.local/nuget`, so it cannot download dependencies.
API tests use synthetic responses and temporary certificates. Browser tests use
separate test executables/ports: Vite 5173, legacy API 5080, synthetic settings TV
5082, HTTPS settings 5443, and fake Immich 5091, all on loopback. The HTTPS browser
fixture pins **only its newly generated test certificate's public key** in an isolated
Chromium process; no host trust store is modified and no blanket TLS bypass is used.
Do not reuse test certificates/credentials or trust-pin flags in production. The
fixture is never included in the Docker image. Physical Windows trust installation,
real TV verification, Docker volume provisioning, and live migration remain pending
explicit deployment approval.

The administrator settings page shows a server-generated saved-key identifier:
first four and last four characters, with each intervening character masked.
Keys of eight characters or fewer are fully masked with eight bullets. Missing
keys show “Not configured”; unreadable saved keys show “Unavailable” so the
replacement/recovery workflow remains usable. The replacement input stays blank.
Successful saves update the identifier immediately; rejected validation retains
the previous identifier and configuration. This metadata is returned only by
administrator-authorized settings routes and never by the TV or phone remote.
