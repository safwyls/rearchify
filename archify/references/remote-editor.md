# Editor access from a remote development environment

Loopback HTTP (`127.0.0.1`, an automatically selected port) remains the default.
Choose either an SSH tunnel or direct HTTPS. These options apply to
`edit start architecture`, foreground `edit architecture`, and discovery
(`edit <diagram.html> --no-open`). Paths in the commands below are on the remote
machine; run from this fork's checkout, or use the installed CLI on PATH.

## SSH forwarding

On the remote machine:

```bash
node archify/bin/archify.mjs edit start architecture diagrams/system.json diagrams/system.html --port 8787
```

On your local machine:

```bash
ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 user@dev.example.com
```

Open the exact `http://127.0.0.1:8787/<session-token>/` URL returned by the remote
command in your local browser. The SSH connection encrypts the network hop;
the editor itself stays bound to remote loopback. If the local forwarding port
is different, start with `--port 8787 --origin http://127.0.0.1:9000` and forward
`127.0.0.1:9000:127.0.0.1:8787`. Use the configured hostname literally:
`localhost` and `127.0.0.1` are different browser origins.

## Direct HTTPS through a hostname

Use a certificate valid for your hostname and trusted by your browser. Keep
the private key outside the repository and readable only by the service user.
For example, on the remote machine:

```bash
node archify/bin/archify.mjs edit start architecture diagrams/system.json diagrams/system.html --host 0.0.0.0 --port 8787 --origin https://dev.example.com:8787 --tls-cert /secure/dev-cert.pem --tls-key /secure/dev-key.pem
```

Open the returned `https://dev.example.com:8787/<session-token>/` URL. Prefer
binding a specific interface IP instead of `0.0.0.0` when possible, and restrict
firewall access to intended clients. IPv6 bind addresses (such as `::1` or `::`)
are supported; wildcard addresses require an explicit browser `--origin`.
Non-loopback binding requires both TLS files by default. Certificate errors are
not bypassed by the application. Explicit unencrypted HTTP is available below.

The tokenized URL grants access to read and overwrite this one source/HTML pair.
Treat it as a password: do not share it, include it in screenshots, or retain it
in proxy access logs. Tokens rotate when the service restarts. Downloaded HTML
omits the live session. The browser still uses **Edit layout → Apply & close →
Save & deliver**, with the same validation and conflict handling as local use.

## Explicit unencrypted HTTP

Only when the user explicitly requests insecure HTTP, pass `--allow-insecure-http`:

```bash
node archify/bin/archify.mjs edit start architecture diagrams/system.json diagrams/system.html --host 0.0.0.0 --port 8787 --origin http://dev.example.com:8787 --allow-insecure-http
```

Open the returned tokenized HTTP URL. This sends diagram content and the session
token without encryption; anyone able to intercept the connection can read them
and use the token to save changes. Use only on a network you trust.
Host, Origin, token, validation, and conflict checks remain active.

The flag also works with foreground editing and discovery, for example
`edit diagrams/system.html --host 0.0.0.0 --port 8787 --origin http://dev.example.com:8787 --allow-insecure-http`.
Supply it on every start or reuse; it is never inherited from discovered metadata
or stored as a persistent default. It cannot be combined with TLS certificates
or an HTTPS origin. Wildcard binding still requires an explicit browser origin.
Agents must not add this flag automatically after TLS setup fails.

## Lifecycle and request checks

Run `edit status <output.html>` and `edit stop <output.html>` on the remote
machine. These commands use a separate token-protected HTTP control endpoint
bound only to `127.0.0.1`; they never connect to a hostname from session metadata
or disable certificate verification. The control endpoint cannot read diagrams
or save files. It closes with the editor service.

Host is matched against the configured browser origin. Save requests also require
that exact Origin and the session token in a custom header. Wildcard host/CORS
allowlists and forwarded-header trust are not enabled. Framing is blocked, and
responses disable caching and referrer disclosure. TLS uses Node's HTTPS server
with TLS 1.2 or newer. See [Node HTTPS](https://nodejs.org/api/https.html) and
[OWASP origin checks](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#using-standard-headers-to-verify-origin).

Network options are explicit for each start, not stored as persistent defaults.
Starting with different network options while a service is running fails; stop
it first. Validation options still persist in `.editor-settings.json`. Session
metadata contains secret URLs and local certificate/key paths; keep it private.

An HTTPS reverse proxy on the same machine can instead forward to loopback HTTP:
set `--port` and the external HTTPS `--origin`, preserve the external Host header,
and forward the token path unchanged. Only a root origin is supported, not a
subpath mount. Keep the backend on loopback; proxy headers alone never authorize
network binding or relax origin checks.
