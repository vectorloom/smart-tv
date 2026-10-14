# Administrator TLS and Windows access — provision only after approval

The exact browser address is **https://localhost:18443/settings**. The certificate
must contain the DNS subject alternative name `localhost` and the TLS server
authentication usage. Certificates match hostnames, not ports: port 18443 is the
Windows end of the SSH tunnel; port 8443 is the server end. Do not use the server's
LAN name/IP or `127.0.0.1` in the browser with this certificate.

## Issuance (before starting the administrator)

The project will provide an explicit, offline `provision-material` CLI operation.
It uses .NET's X.509 CertificateRequest API to issue a one-year self-signed localhost
TLS certificate, and a **different** certificate for wrapping Data Protection keys.
Private keys are written directly to a new, restricted directory (0700, files 0600).
It refuses to overwrite existing material. It prints only success/failure, never
private keys, passwords, PFX data, or the Immich key. No public certificate authority,
package download, or system trust-store change is required on the Linux host.
The administrator refuses to start without explicitly provisioned TLS material.

Only `localhost.cer` is public and should be copied to Windows using the existing
SSH/SCP connection. Compare its SHA-256 file digest at both ends over the authenticated
SSH connection (`sha256sum` on Linux, `Get-FileHash` on Windows) before trusting it.
Do not transfer `localhost.key`, the wrapping private key, or the settings volume.

## Trust on the Windows laptop

After reviewing the certificate and verifying its digest, the user explicitly runs:

```powershell
certutil -user -addstore Root .\localhost.cer
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18443:127.0.0.1:8443 user@server
```

Open `https://localhost:18443/settings` in Edge or Chrome, which use Windows trust.
The certificate must validate without a warning. This installs trust for the supplied
self-signed certificate in the **current user's** trust store, not machine-wide.
Keep its private key protected; remove this trust when retiring the dashboard.
If corporate policy prevents installing user trust, stop and obtain an
organization-issued certificate with SAN `localhost`, or approve a different
HTTPS access design. Do not use browser warning bypasses, `--ignore-certificate-errors`,
or `curl -k` for real administrator access. Firefox may require separately enabling
Windows enterprise-root trust; Edge/Chrome are the documented path.

## Literal loopback isolation with Docker

A port published to host loopback cannot reach a listener bound to **container**
loopback through Docker NAT. Therefore the optional `admin` service uses the same
application image in administrator-only mode with host networking, and Kestrel
explicitly binds **127.0.0.1:8443**. It does not listen on the host LAN address or
publish any port. This service is part of `smart-tv`, not an existing service.
The public dashboard retains its independent bridge network and existing 8080
mapping. Both read the project-specific settings volume; only the admin service
writes it. The public service rejects `/settings` and `/api/admin` before routing,
regardless of credentials or forged forwarding headers. The administrator service
does not serve gallery/remote APIs. This deployment layout is for this Linux host;
Docker Desktop host networking is not assumed.

SSH already authenticates and encrypts the tunnel. Application password/session
checks are still required. No SSH, firewall, Caddy, or Immich changes are needed.
If SSH forwarding is disabled, stop rather than changing the SSH service.

## Renewal

Before the TLS certificate expires, generate fresh material in a new protected
directory, transfer and explicitly trust the new **public** localhost certificate,
and replace only the TLS files during approved maintenance. Verify the new browser
connection before removing old Windows trust (certificate manager, Current User /
Trusted Root Certification Authorities). TLS renewal does **not** require replacing
the wrapping certificate. Keep that certificate and its private key backed up
separately from the encrypted settings volume. No certificate installation,
provisioning, SSH connection, or deployment has been performed by writing this guide.

References: [Microsoft certutil](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil) and [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-10.0).
