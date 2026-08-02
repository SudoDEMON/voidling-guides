# Security Policy

Please report suspected vulnerabilities privately through the repository's
GitHub Security Advisories page. Do not open a public issue containing a secret,
credential, private video URL, local request log, or network configuration.

Local files under `data/` are intentionally excluded from version control. Never
attach that directory to an issue or commit it to a branch.

The Dad portal is available only to clients accepted by the server's LAN
allowlist and still requires its separately configured password. The built-in
server uses plain HTTP, so the password and session are not encrypted in
transit. Keep the service on a trusted LAN with a matching host firewall rule;
use an HTTPS reverse proxy or trusted VPN before exposing it to any untrusted
network. Avoid the `*` client rule unless the surrounding network boundary is
equally restrictive.

Dad removal actions require the authenticated session and exact same-origin JSON
requests. Deleting a library video is restricted to the configured managed
videos directory, and deleting a game is blocked while related library entries
exist. Removal events remain in the append-only audit log.
