# Decisions

Settled decisions, newest last. A dependency is recorded here before it is added.

## Settled with Marcel on 2026-10-10

The open decisions of `docs/PLAN.md`:

1. **Public repo, public image.** github.com/canclini/feedback is public under the MIT license.
   The image will be published on GHCR as a public package, so the VM pulls it without
   credentials. Nothing secret lives in the code.
2. **Name and domain.** `feedback`, served at feedback.canclini.dev. No product name or own
   domain until others use it.
3. **A loader inside each site, no script tag for every visitor.** Each site carries a few
   lines that load `feedback.js` from feedback.canclini.dev only when a site key is in
   `localStorage`. Ordinary visitors never contact the service, and no privacy page changes.
4. **No screenshots** in the first cut. Selector, trimmed `outerHTML`, element text and the
   deployed commit are enough to find the code.
5. **No automatic GitHub issues.** An MCP tool `open_issue(id)` may come later for entries
   bigger than a fix.
6. **Marcel merges.** Agents work on `feedback/<id>` branches and report the branch or PR.
   Standing approval to merge is granted per app, if ever.

## Runtime and tooling

- **Node 24**, the active LTS (the plan said 22, which is in maintenance). TypeScript runs
  directly through Node's type stripping: no build step, no `dist/`. Hence only erasable syntax
  (`erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- **Tests with `node:test`**, no test framework dependency.
- **`node:http`**, no HTTP framework until one earns its place.
- **`node:sqlite` instead of `better-sqlite3`** (the plan named the latter). Node 24 ships
  SQLite without a flag or warning, so there is no native module to build in the image and no
  dependency to update. The API is synchronous like `better-sqlite3`'s.

## Store and API (step 2)

- **Status values are English identifiers:** `new`, `in_progress`, `question`, `done`,
  `dismissed`. The German labels of the plan (*neu*, *in Arbeit*, *Rückfrage*, *erledigt*,
  *verworfen*) are for the widget and the web UI only.
- **Every change is an event**, posted as `{kind, body?, link?}`. The kind decides the new
  status and who may post it (`TRANSITIONS` in `src/store.ts`):

  | Kind | From | To | Who | Body |
  |---|---|---|---|---|
  | `claim` | new | in_progress | agent | optional |
  | `question` | new, in_progress | question | agent | required |
  | `answer` | question | new | owner | required |
  | `resolve` | new, in_progress, question | done | agent | required |
  | `dismiss` | new, in_progress, question | dismissed | agent, owner | required |
  | `reopen` | done, dismissed | new | owner | optional |
  | `note` | any | unchanged | agent, owner | required |

  An answer returns the entry to `new`, so it shows up for agents again with the question and
  the answer in its events. An agent may also resolve an entry that waits on a question, for
  when Marcel settled it with the agent outside the page (decided 2026-10-11); the note says how. A second claim is a conflict (409), so two agents never work on the
  same entry.
- **The owner on a page is Marcel through a site key.** The page cannot use a session cookie of
  feedback.canclini.dev (third party), so answering a question and reopening go through the site
  key, which is limited to its app. An entry of another app answers 404, not 403.
- **Secrets** are 32 random bytes in base64url with a kind prefix: `fbs_` for site keys, `fba_`
  for agent tokens. Stored as SHA-256 only; with that much entropy a slow hash buys nothing.
- **Agent tokens are refused when a request carries an `Origin` header.** They belong in an
  agent's secret store, never in a page, so a leaked one cannot be used from a browser.
- **Site keys are checked against the page origin** when the browser sends one, and the entry's
  `url` must be a page of the app.
- **The app registry is `apps.json` in this repo**, read and upserted on every start. Which repo
  and branch an app deploys from is reviewed like code. An app removed from the file stays in
  the database, because its entries still point at it.
- **Context fields are cut, not refused** (`element_html` at 4 KB, the widget trims to 2 KB):
  a long element must not lose the comment that came with it. The comment itself is refused
  above 4000 characters, a request body above 64 KB.
- **Keys and tokens are managed with `src/cli.ts`** until the web UI takes over in step 4.

## Dependencies

| Package | Kind | Why |
|---|---|---|
| `typescript` | dev | `tsc` as the type checker (`npm run typecheck`); emits nothing. |
| `@types/node` | dev | Node's types for the type checker, pinned to the runtime's major (24). |
| `@modelcontextprotocol/server` | runtime | The MCP server (v2 of the TypeScript SDK, spec 2026-07-28, with stateless serving of 2025-era clients). Depends only on `zod` and `@modelcontextprotocol/core`. |
| `zod` | runtime | Input and output schemas of the MCP tools; the SDK takes zod schemas. |
| `@simplewebauthn/server` | runtime | Passkey registration and sign-in: verifies attestations and assertions (CBOR, COSE, signatures), which is easy to get subtly wrong by hand. |
| `@modelcontextprotocol/client` | dev | The SDK's client, to test the MCP tools over real HTTP. |

## Commits on a public repo

- Pull requests are merged with **rebase**, so each commit lands on main as written and the
  history stays linear. Every commit of a PR therefore has to stand on its own.
- `bin/check-commits.ts` checks every commit of a PR in CI against the rules in
  `CONTRIBUTING.md`; a violation fails the PR.

## MCP (step 3)

- **SDK v2 split packages, not `@modelcontextprotocol/sdk` v1** (the plan named v1). v1 pulls in
  Express, Hono, ajv and a dozen more; `@modelcontextprotocol/server` needs only zod. Its
  `createMcpHandler` speaks web-standard `Request`/`Response`; the dozen lines that adapt
  `node:http` live in `src/mcp.ts`, so `@modelcontextprotocol/node` (which brings Hono) is not
  needed.
- **Stateless, one server instance per request**, built for the caller's token. 2025-era clients
  are served statelessly too (`legacy: "stateless"`), so Claude Code connects whichever protocol
  revision it speaks.
- **Only agent tokens** are accepted on `/mcp`, by the same rules as the API (refused with an
  `Origin` header). A read token sees only the reading tools, so a model is never offered a tool
  it cannot use.
- **Tool errors are tool results** (`isError: true` with the reason), not protocol errors, so the
  model reads why a claim failed and can pick another entry.
- **The working rules live in `src/loop.ts`** and are served twice: as the server's
  `instructions` and as the prompt `work_through_feedback`.

## Passkeys and web UI (step 4)

- **No `@simplewebauthn/browser`** (the plan named it). Browsers since 2025 parse and serialise
  WebAuthn options natively (`PublicKeyCredential.parseCreationOptionsFromJSON`,
  `credential.toJSON()`), so the sign-in page needs a few lines of its own script and no
  bundle served from `node_modules`.
- **Server-rendered HTML with plain forms.** No framework, no client-side app. JavaScript only
  for the passkey ceremonies. Every page is built with an escaping template tag (`src/html.ts`).
- **First passkey with a setup code.** While no passkey exists, the service prints a fresh
  one-time code to its log on every start. It is kept in memory only. Once a passkey is
  registered, setup is closed; further passkeys are added from a signed-in session.
- **Sessions in SQLite**, 30 days, as a `__Host-session` cookie (HttpOnly, Secure,
  SameSite=Lax). Stored as a hash like the other secrets. Every state-changing request of the
  UI must come with an `Origin` header equal to `PUBLIC_URL`. Lax since 2026-10-14: under
  Strict a link from elsewhere (Hex's board, a mail) opened the sign-in page every time. The
  GET pages only read, and the Origin check guards every POST, so Lax gives nothing away.
- **`Referrer-Policy: same-origin`, not `no-referrer`.** Under `no-referrer` Chrome sends
  `Origin: null` with form posts, and the origin check refuses them. `same-origin` still sends
  no referrer to the sites an entry links to.
- **`PUBLIC_URL`** (default `http://localhost:8080`) sets the WebAuthn relying party: its
  hostname is the RP ID, its origin the expected origin. Passkeys registered for one hostname do
  not work on another, so it must be `https://feedback.canclini.dev` in production from the
  first registration on.
- **"Auf <App> aktivieren"** creates a site key and redirects to the app's first origin with
  `#feedback-key=<key>`. The fragment never reaches a server; the widget (step 5) stores it and
  removes it from the address bar. The CSP's `form-action` allows the registered origins for
  this redirect.
- **The web UI acts as the owner without an app**, so it sees and answers entries of every app
  through the same store rules as a site key.

## Widget (step 5)

- **The site key decides the app, not the script tag.** The loader needs no `data-app`: the
  service knows the app from the key, so one loader text fits every site.
- **Everything the widget draws lives in one shadow root**, styled with a constructed
  stylesheet (`adoptedStyleSheets`). A page's `style-src` does not govern those, so a site's CSP
  only needs `script-src` and `connect-src` for the service. Markers are overlays positioned
  over the element; the page's own DOM and classes are never touched. No `innerHTML`: all nodes
  are built with the DOM API, so page or entry text is never parsed as markup.
- **The shadow root is open**, so the browser tests can reach into it. Closing it would not
  protect anything from the page's own scripts.
- **Polling every 20 seconds** while the tab is visible, plus on returning to the tab. No
  server push: the service stays stateless per request, and a few seconds of delay do not
  matter for this loop.
- **Entries belong to a page by origin and path**, not the full URL, so query strings and
  fragments do not hide an entry from its page.
- **`GET /v1/entries` includes each entry's `last_event`**, so the widget shows the latest note
  or question without a request per entry.
- **Size: 18 KB, 6 KB gzipped**, served compressed by the service. More than "a few KB" in the
  plan, because answering a question and reopening happen on the page itself.
- **Browser tests** (`test/browser/`) drive headless Chromium or Chrome over the DevTools
  protocol with Node's built-in WebSocket, no dependency. They skip when no browser is found
  and run in CI, where the runner image has Chrome.

## Deploy (step 6)

- **The image is published by this repo's CI** as `ghcr.io/canclini/feedback:main` (and
  `:<sha>`) on every green commit to main. The package is public, so the VM pulls it without a
  credential. canclini-infra's compose file names `:main`.
- **This repo's CI also rolls it out**: it runs canclini-infra's `platform/deploy.sh` on the VM
  as `deploy`, as canclini.web does for the website, then waits until
  `https://feedback.canclini.dev/health` reports the commit. canclini-infra keeps describing the
  service (compose, Caddy, DNS, backup); this repo only says when a new image is ready.
- **Backups read a snapshot, never the live database.** The service writes
  `SNAPSHOT_PATH` (`/data/snapshot.db` in the image) on start and every hour through SQLite's
  backup API, to a temporary file renamed into place. The nightly backup in canclini-infra
  copies that file with the data directory mounted read-only. Running `docker compose exec`
  from the backup container instead would need the Docker socket, which is root on the VM.
  `node src/cli.ts backup <file>` writes the same snapshot on demand.
- **`/srv/data/feedback` belongs to uid 1000** (`node` in the image). canclini-infra's
  `deploy.sh` creates it idempotently, because a change to cloud-init replaces the VM.
