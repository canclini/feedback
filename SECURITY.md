# Security

## Reporting a vulnerability

Report it privately through GitHub: on https://github.com/canclini/feedback, Security →
Report a vulnerability (https://github.com/canclini/feedback/security/advisories/new). Do not
open a public issue or pull request for it.

Say what an attacker can do, against which version (commit), and how to reproduce it. Do not
include real keys, tokens or setup codes; generate your own on a local instance (`README.md`,
"Quick start").

## Supported versions

Only `main`, and the image built from it (`ghcr.io/canclini/feedback:main`). There are no
release branches; fixes land on `main` and in the next image.

## Threat model

One instance serves one owner. Everything the owner does goes through a passkey session in the
web UI or a site key in the owner's browser; agents act with agent tokens. Visitors of the sites
never talk to the service.

### Sign-in

- Passkeys only (WebAuthn through `@simplewebauthn/server`), no passwords. Registration requires
  a resident key and user verification; sign-in requires user verification. The relying party
  ID is the hostname of `PUBLIC_URL`, the expected origin its origin.
- The first passkey needs a one-time setup code: 20 characters from a 32-letter alphabet
  (100 bits), new on every start while no passkey exists, kept in memory and printed to the log
  only. Once a passkey exists, setup is closed. Anyone who can read the log before the first
  passkey is registered can take the instance, so register one right after the first start.
- Further passkeys are added only from a signed-in session. The last passkey cannot be removed,
  so setup cannot open again.
- A ceremony's challenge is used once and expires after 5 minutes.

### Sessions and the web UI

- The session is 32 random bytes in the cookie `__Host-session`: `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, 30 days. The database keeps only its SHA-256 hash; signing out
  deletes it.
- Every POST to the web UI must carry an `Origin` header equal to `PUBLIC_URL`, or it is
  refused with 403. With `SameSite=Lax` a cross-site POST carries no cookie anyway; the GET
  pages only read.
- Every page is rendered with an escaping template tag (`src/html.ts`) and sent with
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self'; connect-src 'self'; form-action 'self' <registered origins>;
  frame-ancestors 'none'; base-uri 'none'`, plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin` and `Cache-Control: no-store`. `form-action` lists the
  registered origins because "Aktivieren" redirects there.

### Site keys

- A site key (`fbs_` plus 32 random bytes) belongs to one app. With it a browser can create
  entries for that app, read that app's entries, and answer, reopen, dismiss or add a note to
  them. An entry of another app answers 404, so a key cannot probe which ids exist.
- When the request carries an `Origin` header, it must be one of the app's origins, and every
  entry's `url` must be a page on one of them. CORS headers on `/v1` are sent only to registered
  origins. A request without `Origin` (not from a browser) is still limited to the key's app.
- The key reaches the site in the URL fragment, which browsers do not send to servers; the
  widget moves it to the site's `localStorage` and removes it from the address bar. Any script
  running on the site can read it there: a site key is only as safe as the site's own scripts.
  Revoke it under Zugänge or with `node src/cli.ts site-key revoke <id>`.

### Agent tokens

- An agent token (`fba_` plus 32 random bytes) has the scope `read` (list and get entries, the
  registry) or `write` (also create entries, claim, ask, resolve, dismiss, note), across all
  apps of the instance. It cannot reach the web UI.
- The HTTP API and `/mcp` refuse an agent token on any request that carries an `Origin` header,
  so a token cannot be used from a web page. `/mcp` accepts agent tokens only.

### Secrets at rest

Site keys, agent tokens and sessions are stored as SHA-256 hashes; they carry 256 random bits,
so a slow password hash would add nothing. A created key or token is shown once. Passkeys are
stored as public keys. The setup code is never written to the database.

### What the widget sends

The widget runs only in a browser that holds a site key. It talks only to the service it was
loaded from. Every 20 seconds while the tab is visible it reads the app's entries; when the
owner submits a comment it sends the page URL, the content of `<meta name="app-version">`, the
element's CSS selector, its text (up to 400 characters) and trimmed `outerHTML` (up to 2 KB),
the viewport size, the browser's user agent, and the comment. It sets no cookies. Everything it
draws lives in a shadow root built with the DOM API, never `innerHTML`, so page and entry text
is never parsed as markup.

### Limits

Request bodies are limited to 64 KB, comments and event bodies to 4000 characters, links to
500; context fields are cut to length.

### Out of scope, or the operator's job

- TLS: the service speaks plain HTTP and expects a reverse proxy with HTTPS in front of it.
- Rate limiting: the service has none; put it in the reverse proxy if the instance is exposed.
- The host, the Docker daemon and the database file: whoever can read `/data` can read every
  entry; whoever can write it can add a passkey.
- The registry (`APPS_PATH`): which origins may use site keys and which repo an entry points
  an agent to are taken from it as they are.
